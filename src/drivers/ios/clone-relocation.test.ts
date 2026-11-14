import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteOpener } from "../../ports/index.js";
import { relocationRewrite } from "./clone-relocation.js";

const origin = "11111111-2222-3333-4444-555555555555";
const copy = "00000000-0000-0000-0000-0000000000CC";
// why: per process, so two overlapping runs never delete each other's files.
const directory = `${process.cwd()}/.simlock-relocation-test-${String(process.pid)}`;

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

// why: pure logic with many cases (testing rule 6): the encodings, links, the cache rule and SQLite's write-ahead log, which the driver's surface cannot vary.
describe("relocationRewrite", () => {
  it("replaces the origin's UDID with the copy's as UTF-8 and UTF-16LE text and in link targets, and leaves what does not name it", () => {
    const rewrite = relocationRewrite(origin, copy);
    const text = Buffer.from(
      `<string>/Devices/${origin}/data/x</string><string>${origin}</string>`,
    );
    const wide = Buffer.from(`zone ${origin} end`, "utf16le");

    expect(rewrite.file(text)?.toString()).toBe(
      `<string>/Devices/${copy}/data/x</string><string>${copy}</string>`,
    );
    expect(rewrite.file(wide)?.toString("utf16le")).toBe(`zone ${copy} end`);
    expect(rewrite.file(Buffer.from("names nothing"))).toBeUndefined();
    expect(rewrite.link(`/Logs/CoreSimulator/${origin}`)).toBe(`/Logs/CoreSimulator/${copy}`);
    expect(rewrite.link("/Logs/CoreSimulator/other")).toBeUndefined();
  });

  it("lets a file the host may not open leave the copy only under a Library/Caches folder", () => {
    const rewrite = relocationRewrite(origin, copy);

    expect(rewrite.unreadable("Containers/Data/Application/A/Library/Caches/x.db")).toBe(true);
    expect(rewrite.unreadable("Library/Caches/com.apple.x/y")).toBe(true);
    expect(rewrite.unreadable("Library/Preferences/com.apple.x.plist")).toBe(false);
    expect(rewrite.unreadable("Caches/Library/x")).toBe(false);
  });

  it("refuses UDIDs of different lengths, which no in-place rewrite can swap", () => {
    expect(() => relocationRewrite(origin, "short")).toThrow(/differ in length/);
  });

  it("keeps every committed transaction of a rewritten SQLite write-ahead log", async () => {
    mkdirSync(`${directory}/copy`, { recursive: true });
    const sqlite = new NodeSqliteOpener();
    const database = await sqlite.open(`${directory}/state.db`, { readOnly: false });
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    database.exec("CREATE TABLE paths (path TEXT)");
    for (let row = 0; row < 3; row += 1) {
      database
        .prepare("INSERT INTO paths VALUES (?)")
        .run(`/Devices/${origin}/data/${String(row)}`);
    }
    copyFileSync(`${directory}/state.db`, `${directory}/copy/state.db`);
    copyFileSync(`${directory}/state.db-wal`, `${directory}/copy/state.db-wal`);
    database.close();
    const rewrite = relocationRewrite(origin, copy);
    for (const name of ["state.db", "state.db-wal"]) {
      const path = `${directory}/copy/${name}`;
      const next = rewrite.file(readFileSync(path));
      if (next !== undefined) writeFileSync(path, next);
    }

    const copied = await sqlite.open(`${directory}/copy/state.db`, { readOnly: false });
    try {
      expect(copied.prepare("SELECT path FROM paths ORDER BY rowid").all()).toEqual([
        { path: `/Devices/${copy}/data/0` },
        { path: `/Devices/${copy}/data/1` },
        { path: `/Devices/${copy}/data/2` },
      ]);
    } finally {
      copied.close();
    }
  });
});
