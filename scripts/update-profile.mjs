import { readFile, writeFile, mkdir } from "node:fs/promises";

const USER = "Adam-Hubbs";
const TOKEN = process.env.GITHUB_TOKEN;
const CACHE_PATH = "data/commit-languages.json";
const OTHER_THRESHOLD = 0.01;
const EXCLUDED_PATH = /(^|\/)(vendor|node_modules|dist|renv|fixtures|_snaps|__snapshots__)\/|(\.lock|lock\.json|-lock\.(json|ya?ml))$/;

const EXTENSIONS = {
  r: "R",
  rmd: "R",
  rd: "R",
  qmd: "Quarto",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  rs: "Rust",
  py: "Python",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  c: "C",
  h: "C",
  cpp: "C++",
  cc: "C++",
  hpp: "C++",
  css: "CSS",
  html: "HTML",
  md: "Markdown",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  sql: "SQL",
  ps1: "PowerShell",
  bat: "Batchfile",
};

const PALETTE = ["#4C8DFF", "#2BB3A3", "#F08A4B", "#F2C14E", "#B07CFF", "#E5609B", "#5CC8FF", "#9BD16B"];
const OTHER_COLOR = "#8B949E";

const THEMES = {
  light: { background: "#FFFFFF", foreground: "#1F2328", muted: "#656D76" },
  dark: { background: "#0D1117", foreground: "#E6EDF3", muted: "#8B949E" },
};

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "profile-updater",
};

async function rest(path, attempt = 0) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 403 || res.status === 429) {
    const text = await res.text();
    if (text.includes("rate limit") && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 65_000));
      return rest(path, attempt + 1);
    }
    throw new Error(`${path} failed: ${res.status} ${text}`);
  }
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function restAll(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await rest(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const { data, errors } = await res.json();
  if (errors) throw new Error(JSON.stringify(errors));
  return data;
}

async function fetchActivity() {
  const data = await graphql(
    `query ($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar { totalContributions }
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
        }
      }
    }`,
    { login: USER },
  );
  return data.user.contributionsCollection;
}

async function searchNonForkCommits() {
  const currentYear = new Date().getUTCFullYear();
  const commits = [];
  for (let year = 2008; year <= currentYear; year++) {
    const query = encodeURIComponent(`author:${USER} author-date:${year}-01-01..${year}-12-31`);
    for (let page = 1; page <= 10; page++) {
      const { items, total_count } = await rest(`/search/commits?q=${query}&per_page=100&page=${page}`);
      commits.push(...items.filter((item) => !item.repository.fork));
      if (items.length < 100 || page * 100 >= total_count) break;
    }
  }
  return commits;
}

async function listForkCommits() {
  const repos = await restAll(`/users/${USER}/repos?type=owner`);
  const forks = repos.filter((repo) => repo.fork);
  const perFork = await Promise.all(
    forks.map((fork) => restAll(`/repos/${fork.full_name}/commits?author=${USER}`)),
  );
  return perFork.flatMap((commits, i) =>
    commits.map((commit) => ({ sha: commit.sha, repo: forks[i].full_name, date: commit.commit.author.date })),
  );
}

function chunk(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}

function languageFor(filename) {
  const extension = filename.split(".").at(-1).toLowerCase();
  return EXTENSIONS[extension] ?? "Other";
}

function linesByLanguage(files) {
  const languages = new Map();
  for (const { filename, additions, deletions } of files) {
    if (EXCLUDED_PATH.test(filename)) continue;
    const language = languageFor(filename);
    const lines = languages.get(language) ?? 0;
    languages.set(language, lines + additions + deletions);
  }
  return languages;
}

async function readCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function updateCache() {
  const cache = await readCache();

  const [searched, forked] = await Promise.all([searchNonForkCommits(), listForkCommits()]);
  const discovered = new Map();
  for (const item of searched) {
    discovered.set(item.sha, { repo: item.repository.full_name, date: item.commit.author.date });
  }
  for (const commit of forked) {
    if (!discovered.has(commit.sha)) discovered.set(commit.sha, { repo: commit.repo, date: commit.date });
  }

  const missing = [...discovered].filter(([sha]) => !cache[sha]);
  console.log(`Found ${discovered.size} commits; ${missing.length} new to fetch.`);

  for (const batch of chunk(missing, 10)) {
    await Promise.all(
      batch.map(async ([sha, { repo, date }]) => {
        try {
          const detail = await rest(`/repos/${repo}/commits/${sha}`);
          const files = (detail.files ?? []).map(({ filename, additions, deletions }) => ({
            filename,
            additions,
            deletions,
          }));
          cache[sha] = { repo, date, files };
        } catch (error) {
          console.warn(`Skipping ${repo}@${sha.slice(0, 7)}: ${error.message}`);
        }
      }),
    );
  }

  await mkdir("data", { recursive: true });
  await writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

function languageShares(cache) {
  const totals = new Map();
  for (const { files } of Object.values(cache)) {
    for (const [language, lines] of linesByLanguage(files)) {
      totals.set(language, (totals.get(language) ?? 0) + lines);
    }
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const shares = new Map();
  for (const [language, lines] of totals) {
    const key = lines / sum < OTHER_THRESHOLD ? "Other" : language;
    const current = shares.get(key) ?? { share: 0, lines: 0 };
    shares.set(key, { share: current.share + lines / sum, lines: current.lines + lines });
  }
  const sorted = [...shares].sort((a, b) => b[1].share - a[1].share);
  return { rows: sorted, totalLines: sum };
}

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function languageSvg(rows, totalLines, theme) {
  const { background, foreground, muted } = THEMES[theme];
  const width = 720;
  const top = 92;
  const rowHeight = 46;
  const height = top + rows.length * rowHeight + 20;
  const trackStart = 200;
  const trackWidth = width - trackStart - 110;
  let paletteIndex = 0;

  const bars = rows
    .map(([language, { share, lines }], i) => {
      const y = top + i * rowHeight;
      const color = language === "Other" ? OTHER_COLOR : PALETTE[paletteIndex++ % PALETTE.length];
      const barWidth = (share * trackWidth).toFixed(1);
      const delay = (i * 0.12).toFixed(2);
      const labelDelay = (Number(delay) + 0.7).toFixed(2);
      return `  <text x="28" y="${y + 18}" class="label">${escapeXml(language)}</text>
  <text x="28" y="${y + 34}" class="caption">${lines.toLocaleString("en-US")} lines</text>
  <rect x="${trackStart}" y="${y + 13}" width="${trackWidth}" height="14" rx="7" fill="${muted}" fill-opacity="0.14"/>
  <rect x="${trackStart}" y="${y + 13}" width="0" height="14" rx="7" fill="${color}">
    <animate attributeName="width" values="0;${barWidth}" keyTimes="0;1" calcMode="spline" keySplines="0.22 1 0.36 1" dur="1.1s" begin="${delay}s" fill="freeze"/>
  </rect>
  <text x="${width - 28}" y="${y + 26}" class="value" text-anchor="end" opacity="0">${(share * 100).toFixed(1)}%
    <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="${labelDelay}s" fill="freeze"/>
  </text>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Share of lines changed by language">
  <style>
    .title { font: 600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${foreground}; }
    .subtitle { font: 400 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${muted}; }
    .label { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${foreground}; }
    .caption { font: 400 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${muted}; }
    .value { font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: ${foreground}; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${background}" stroke="${muted}" stroke-opacity="0.2"/>
  <text x="28" y="34" class="title">Languages by lines changed</text>
  <text x="28" y="54" class="subtitle">${totalLines.toLocaleString("en-US")} lines added or removed across my commits, including forks and other orgs. All time.</text>
${bars}
</svg>
`;
}

function replaceSection(text, name, content) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(text)) throw new Error(`Missing README section: ${name}`);
  return text.replace(pattern, () => `${start}\n${content}\n${end}`);
}

function badge(label, value, color) {
  return `![${label}](https://img.shields.io/badge/${encodeURIComponent(label)}-${value}-${color}?style=flat-square)`;
}

const [user, activity, cache] = await Promise.all([
  rest(`/users/${USER}`),
  fetchActivity(),
  updateCache(),
]);

const { rows, totalLines } = languageShares(cache);

for (const theme of Object.keys(THEMES)) {
  await writeFile(`assets/languages-${theme}.svg`, languageSvg(rows, totalLines, theme));
}

const readme = await readFile("README.md", "utf8");

const stats = [
  badge("public repos", user.public_repos, "2BB3A3"),
  badge("contributions (last year)", activity.contributionCalendar.totalContributions, "F08A4B"),
].join("\n");

const updated = replaceSection(readme, "stats", stats);
await writeFile("README.md", updated);

console.log(`Updated profile for ${USER}: ${rows.length} languages, ${totalLines.toLocaleString("en-US")} lines across ${Object.keys(cache).length} commits.`);
