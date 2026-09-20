"use strict";
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
// Strip proxy env vars: local env proxies (e.g. a dead 127.0.0.1:port) have
// broken pushes before; direct connection to github.com works.
const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" });
["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].forEach(
  (k) => delete env[k]
);
const r = spawnSync("git", args, {
  encoding: "utf8",
  cwd: "C:/Users/Biens/Documents/workspace/sre",
  env,
});
console.log("== status:", r.status, "==");
if (r.stdout && r.stdout.trim()) console.log("-- stdout --\n" + r.stdout);
if (r.stderr && r.stderr.trim()) console.log("-- stderr --\n" + r.stderr);
if (r.error) console.log("-- error --\n" + (r.error.stack || r.error));
