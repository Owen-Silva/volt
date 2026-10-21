// VOLT — `volt upgrade`: check for a newer version.
//
// VOLT is installed from its GitHub repository, not from npm (the npm name
// "volt" belongs to an unrelated package). With no override, `volt upgrade`
// prints how to update a source install with git. Set VOLT_UPGRADE_URL to a
// JSON endpoint to check a published release: the GitHub "latest release" API
// (RELEASES_API below, reads `tag_name`) or any {"version": "x.y.z"} document;
// tests use this hook.
import { VERSION, bold, green, gray } from "./util.js";

export const REPO_URL = "https://github.com/Owen-Silva/volt";
export const RELEASES_API = "https://api.github.com/repos/Owen-Silva/volt/releases/latest";
const UPDATE_HINT = "git pull && npm install -g .";

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// {"version": "1.2.3"} or a GitHub release {"tag_name": "v1.2.3"}.
function versionFrom(json) {
  const raw = json?.version || json?.tag_name;
  return raw ? String(raw).replace(/^v/i, "") : null;
}

export async function checkUpgrade({ quiet = false } = {}) {
  const url = process.env.VOLT_UPGRADE_URL;
  if (!url) {
    // No release endpoint to ask: this is a source install from GitHub.
    if (!quiet) {
      console.log(gray(`volt ${VERSION} — installed from local source.`));
      console.log(gray(`  update with: ${UPDATE_HINT}`));
    }
    return 0;
  }

  let remote;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json", "user-agent": `volt/${VERSION}` },
    });
    if (!res.ok) throw new Error(`release check responded ${res.status}`);
    remote = versionFrom(await res.json());
    if (!remote) throw new Error("no version or tag_name field in response");
  } catch (err) {
    if (quiet) return 0;
    console.log(gray(`could not check for updates (${err.message})`));
    console.log(gray(`  current: volt ${VERSION}`));
    return 0; // never fail hard on an update check
  }

  const cmp = compareVersions(remote, VERSION);
  if (cmp > 0) {
    console.log(`  ${green("↑")} new version available: ${bold(remote)} (you have ${VERSION})`);
    console.log(gray(`  update your clone: ${UPDATE_HINT}`));
    console.log(gray(`  releases: ${REPO_URL}/releases`));
    return 0;
  }
  if (cmp === 0) {
    console.log(green("✓ ") + `up to date (volt ${VERSION})`);
    return 0;
  }
  console.log(gray(`running volt ${VERSION} — newer than the latest release ${remote}`));
  return 0;
}
