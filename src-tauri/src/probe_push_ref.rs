// probe: does git2::Remote::push update refs/remotes/origin/<branch>?
#[test]
fn probe_push_updates_tracking_ref() {
    use git2::{Repository, Signature};
    let base = std::env::temp_dir().join(format!("probe_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    let bare = base.join("remote.git");
    Repository::init_bare(&bare).unwrap();

    let work = base.join("work");
    let repo = Repository::init(&work).unwrap();
    repo.remote("origin", bare.to_str().unwrap()).unwrap();

    let sig = Signature::now("t", "t@t.local").unwrap();
    // commit 1
    std::fs::write(work.join("a.txt"), "1").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("a.txt")).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "c1", &tree, &[]).unwrap();

    let branch = repo.head().unwrap().shorthand().unwrap().to_string();
    println!("branch = {branch}");

    let mut remote = repo.find_remote("origin").unwrap();
    remote.push(&[&format!("refs/heads/{branch}:refs/heads/{branch}")], None).unwrap();

    let tracking = format!("refs/remotes/origin/{branch}");
    match repo.refname_to_id(&tracking) {
        Ok(oid) => println!("PUSH #1: tracking ref EXISTS -> {oid}"),
        Err(e) => println!("PUSH #1: tracking ref MISSING ({})", e.message()),
    }

    // commit 2, push again
    std::fs::write(work.join("a.txt"), "2").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("a.txt")).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    let c2 = repo.commit(Some("HEAD"), &sig, &sig, "c2", &tree, &[&parent]).unwrap();

    let mut remote = repo.find_remote("origin").unwrap();
    remote.push(&[&format!("refs/heads/{branch}:refs/heads/{branch}")], None).unwrap();

    match repo.refname_to_id(&tracking) {
        Ok(oid) if oid == c2 => println!("PUSH #2: tracking ref UP TO DATE with HEAD -> {oid}"),
        Ok(oid) => println!("PUSH #2: tracking ref STALE -> {oid}, HEAD is {c2}"),
        Err(e) => println!("PUSH #2: tracking ref MISSING ({})", e.message()),
    }

    let head = repo.head().unwrap().target().unwrap();
    if let Ok(remote_oid) = repo.refname_to_id(&tracking) {
        let (ahead, behind) = repo.graph_ahead_behind(head, remote_oid).unwrap();
        println!("graph_ahead_behind(HEAD, tracking) = ahead {ahead}, behind {behind}");
    }
    let _ = std::fs::remove_dir_all(&base);
}
