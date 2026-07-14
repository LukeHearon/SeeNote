// Local-loopback HTTP server backing Fast-mode <video> playback on Linux.
//
// WebKitGTK's GStreamer media pipeline (the `webkitwebsrc` element used for real
// <video>/<audio> playback) has no bridge to Tauri's custom `asset://` scheme
// handler — only WebKit's generic resource loader (fetch, <img>, XHR) does. So
// `<video src="asset://...">` fails immediately with MEDIA_ERR_SRC_NOT_SUPPORTED
// there, even though the exact same file plays fine via `fetch()` and decodes
// cleanly via GStreamer directly. Serving over real `http://127.0.0.1` sidesteps
// this: GStreamer's `souphttpsrc` understands plain HTTP natively.
//
// macOS/Windows are unaffected (their WebViews' custom-scheme handling doesn't
// have this gap), so the frontend only calls `get_video_server_url` on Linux.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::net::TcpListener;
use std::sync::OnceLock;
use std::time::Instant;

use http_range::HttpRange;
use tiny_http::{Header, Method, Response, StatusCode};

static SERVER_PORT: OnceLock<u16> = OnceLock::new();

fn ensure_started() -> Result<u16, String> {
    if let Some(&port) = SERVER_PORT.get() {
        return Ok(port);
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let server = tiny_http::Server::from_listener(listener, None).map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            std::thread::spawn(move || {
                if let Err(e) = handle_request(request) {
                    eprintln!("[video_server] request error: {e}");
                }
            });
        }
    });

    // Another thread may have raced us to set this; either way the port that
    // wins is the one actually bound and listening, since only one call to
    // bind("127.0.0.1:0") above ever gets stored.
    Ok(*SERVER_PORT.get_or_init(|| port))
}

fn handle_request(request: tiny_http::Request) -> std::io::Result<()> {
    let started = Instant::now();
    let method = request.method().as_str().to_string();
    let raw_path = request.url().trim_start_matches('/');
    let path = percent_encoding::percent_decode_str(raw_path)
        .decode_utf8_lossy()
        .to_string();
    let basename = path.rsplit('/').next().unwrap_or(&path).to_string();

    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());
    eprintln!(
        "[video_server] -> {method} {basename} range={}",
        range_header.as_deref().unwrap_or("none")
    );

    let file = match File::open(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[video_server] <- 404 {basename} (open failed: {e})");
            return request.respond(Response::empty(StatusCode(404)));
        }
    };

    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(e) => {
            eprintln!("[video_server] <- 500 {basename} (metadata failed: {e})");
            return request.respond(Response::empty(StatusCode(500)));
        }
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream().to_string();

    if let Some(range_header) = range_header {
        let result = serve_range(request, file, len, &mime, &range_header);
        eprintln!(
            "[video_server] <- range response {basename} in {:?} ok={}",
            started.elapsed(),
            result.is_ok()
        );
        result
    } else if request.method() == &Method::Head {
        let response = Response::empty(StatusCode(200))
            .with_header(content_type_header(&mime))
            .with_header(header("Content-Length", &len.to_string()))
            .with_header(header("Accept-Ranges", "bytes"));
        let result = request.respond(response);
        eprintln!("[video_server] <- 200 HEAD {basename} in {:?}", started.elapsed());
        result
    } else {
        // Even though this isn't a Range request, `Accept-Ranges: bytes` must be
        // present here too: GStreamer's souphttpsrc (and likely other seek-probing
        // clients) decide up front, from this very first response, whether the
        // resource supports random-access seeking at all. Without it here, it falls
        // back to push-mode sequential streaming — which breaks both scrubbing
        // (no real seeking) and qtdemux's ability to find a trailing `moov` atom
        // beyond its 10MB streaming-mode scan window.
        //
        // Stream the file straight off disk rather than reading it all into a Vec,
        // so a large media file doesn't cost its full size in RAM per request.
        // `Some(len)` sets Content-Length; `with_chunked_threshold(MAX)` stops
        // tiny_http from forcing `Transfer-Encoding: chunked` (which would hide the
        // total size from souphttpsrc and defeat seekability detection).
        let headers = vec![content_type_header(&mime), header("Accept-Ranges", "bytes")];
        let response = Response::new(StatusCode(200), headers, file, Some(len as usize), None)
            .with_chunked_threshold(usize::MAX);
        let result = request.respond(response);
        eprintln!("[video_server] <- 200 whole-body {basename} in {:?}", started.elapsed());
        result
    }
}

fn serve_range(
    request: tiny_http::Request,
    mut file: File,
    len: u64,
    mime: &str,
    range_header: &str,
) -> std::io::Result<()> {
    let not_satisfiable = |request: tiny_http::Request, why: &str| {
        eprintln!("[video_server] <- 416 range={range_header} len={len} ({why})");
        request.respond(
            Response::empty(StatusCode(416)).with_header(header("Content-Range", &format!("bytes */{len}"))),
        )
    };

    let ranges = match HttpRange::parse(range_header, len) {
        Ok(r) => r,
        Err(e) => return not_satisfiable(request, &format!("parse error: {e:?}")),
    };
    let Some(first) = ranges.first() else {
        return not_satisfiable(request, "no ranges parsed");
    };
    let (start, end) = (first.start, first.start + first.length - 1);
    if start >= len || end >= len || end < start {
        return not_satisfiable(request, "out of bounds");
    }

    // Honor the full requested range through to its end. Both souphttpsrc and
    // WebKitGTK's webkitwebsrc issue open-ended `Range: bytes=N-` ("everything
    // from N") and expect exactly that back; truncating to a fixed cap made
    // webkitwebsrc read the short-but-*complete* body as end-of-resource and fire
    // a premature EOS — the Linux Fast-mode freeze/jump-to-EOF (see
    // local/video-issues.md). The body is streamed off disk (`file.take`), so an
    // open-ended range on a multi-GB file is a bounded sequential read, not a
    // full in-memory buffer. `Some(nbytes)` sets Content-Length;
    // `with_chunked_threshold(MAX)` keeps the 206 from being forced to chunked
    // (which would hide the size and defeat seekability detection).
    let nbytes = end + 1 - start;
    file.seek(SeekFrom::Start(start))?;
    let headers = vec![
        content_type_header(mime),
        header("Accept-Ranges", "bytes"),
        header("Content-Range", &format!("bytes {start}-{end}/{len}")),
    ];
    let response = Response::new(StatusCode(206), headers, file.take(nbytes), Some(nbytes as usize), None)
        .with_chunked_threshold(usize::MAX);
    request.respond(response)
}

fn content_type_header(mime: &str) -> Header {
    header("Content-Type", mime)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header name/value is valid")
}

/// Starts the loopback server on first call (idempotent) and returns a URL
/// serving `path` from it, for use as a <video>/<audio> element's `src`.
#[tauri::command]
pub fn get_video_server_url(path: String) -> Result<String, String> {
    let port = ensure_started()?;
    let encoded = percent_encoding::utf8_percent_encode(&path, percent_encoding::NON_ALPHANUMERIC);
    Ok(format!("http://127.0.0.1:{port}/{encoded}"))
}
