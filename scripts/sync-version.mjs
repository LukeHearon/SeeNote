#!/usr/bin/env node
// Called by npm's "version" lifecycle hook to keep Cargo.toml and tauri.conf.json in sync.
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

// tauri.conf.json
const tauriConfPath = resolve(root, "src-tauri/tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

// Cargo.toml — simple line replacement to avoid touching anything else
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const updated = cargo.replace(/^version = ".*"/m, `version = "${version}"`);
writeFileSync(cargoPath, updated);

// Cargo.lock — update just the seenote package's own version entry
const cargoLockPath = resolve(root, "src-tauri/Cargo.lock");
const cargoLock = readFileSync(cargoLockPath, "utf8");
const updatedLock = cargoLock.replace(
  /(\[\[package\]\]\nname = "seenote"\nversion = ").*(")/,
  `$1${version}$2`
);
writeFileSync(cargoLockPath, updatedLock);

console.log(`Synced version ${version} → tauri.conf.json, Cargo.toml, Cargo.lock`);
