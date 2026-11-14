#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계, 국내 근거 조문의 출처 대조(R11), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교", "근거"];

function parseCurriculum(text) {
  const modules = new Map();
  const domestic = new Map();
  const global = new Map();
  const problems = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([MGBPLX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
    domestic.set(id, fields["국내 근거"] || "");
    global.set(id, fields["글로벌 비교"] || "");
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, domestic, global, problems };
}


// sources.md 표: | 법령·기준명 | 확인한 조문 | URL | 조회일 |
function parseSources(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const c = line.split("|").map((s) => s.trim());
    if (c.length < 6 || !/^https?:\/\//.test(c[3]) || !/^\d{4}-\d{2}-\d{2}$/.test(c[4])) continue;
    const arts = new Set((c[2].match(/제\d+조(?:의\d+)?/g) || []));
    rows.set(c[1], arts);
  }
  return rows;
}

function checkDomestic(domestic, sources) {
  const problems = [];
  const names = [...sources.keys()].sort((a, b) => b.length - a.length);
  for (const [id, line] of domestic) {
    if (/^해당 없음/.test(line) && !/^해당 없음 — .{8,}/.test(line)) problems.push(`${id}: 국내 근거 「해당 없음」의 이유가 없거나 짧음`);
    // 법령명 위치를 찾는다(긴 이름 우선, 겹침 제외)
    const hits = [];
    for (const n of names) {
      let i = -1;
      while ((i = line.indexOf(n, i + 1)) !== -1) if (!hits.some((h) => i < h.end && i + n.length > h.start)) hits.push({ name: n, start: i, end: i + n.length });
    }
    hits.sort((a, b) => a.start - b.start);
    for (const m of line.matchAll(/제\d+조(?:의\d+)?/g)) {
      const owner = hits.filter((h) => h.end <= m.index).pop();
      if (!owner) { problems.push(`${id}: ${m[0]}의 법령명이 sources.md에 없음`); continue; }
      if (!sources.get(owner.name).has(m[0])) problems.push(`${id}: ${owner.name} ${m[0]}이 sources.md에서 확인되지 않음`);
    }
    // 괄호 설명을 지우고 쉼표·줄표로 나눈 조각에서 법령·기준명 후보를 뽑는다
    const bare = line.replace(/\([^)]*\)/g, "");
    for (const seg of bare.split(/,|—|·(?= )/)) {
      const name = seg.split(/ 제\d/)[0].replace(/[「」]/g, "").trim();
      if (!/(법률|[가-힣]{2,}법|시행령|심사지침|실시요령|안내서|가이드라인|고시|제도|규칙|기준|지침)$/.test(name)) continue;
      if (!names.some((n) => n === name || name.endsWith(" " + n) || n.startsWith(name + "("))) problems.push(`${id}: 법령·기준명 「${name}」이 sources.md에 없음`);
    }
  }
  return problems;
}

// 글로벌 비교 줄의 식별자(CFR·U.S.C.·EU 문서 번호·조항·기관명)가 sources.md 글로벌 표에 있는지 본다
const GLOBAL_KEYS = [/\d+ CFR (?:Part |§)?\d+(?:\.\d+)?/g, /\d+ U\.S\.C\. \d+/g, /(?:\(EU\) )?\d{4}\/\d+(?:\/EC|\/EU)?/g, /§1798\.\d+/g,
  /\b(?:GDPR|ePrivacy|DSA|CCPA|TCPA|CAN-SPAM|ICC|ESOMAR|WIPO|AMA|FTC Act|EDPB)\b/g];
function checkGlobal(global, sourcesText) {
  const problems = [];
  const table = sourcesText.split("## 글로벌")[1] || "";
  for (const [id, line] of global) {
    if (/^해당 없음/.test(line)) { if (!/^해당 없음 — .{8,}/.test(line)) problems.push(`${id}: 글로벌 비교 「해당 없음」의 이유가 없거나 짧음`); continue; }
    for (const re of GLOBAL_KEYS) for (const m of line.matchAll(re)) {
      const key = m[0].replace(/^\(EU\) /, "").replace(/§(\d+)\.\d+$/, "Part $1");
      const k2 = key.replace(/ Part /, " §").replace(/ §/, " Part ");
      if (!table.includes(key) && !table.includes(k2) && !table.includes(m[0])) problems.push(`${id}: 글로벌 근거 「${m[0]}」이 sources.md 글로벌 표에 없음`);
    }
  }
  return problems;
}

function checkGraduation(text) {
  const need = ["X1", "learner/projects/", "① 타깃", "② 포지셔닝", "③", "④ 채널", "⑤ 측정", "⑥ 가격", "국내 근거", "URL", "조회일", "진출 예정 시장"];
  return need.filter((n) => !text.includes(n)).map((n) => `tutor/assessment.md 졸업 산출물 기준에 「${n}」 없음`);
}

function findVisualAssets(files) {
  return files.filter((f) => /\.(x?html?|css|svgz?|png|jpe?g|gif|webp|avif|ico|bmp|pdf)$/i.test(f) || (/\.(m?js|cjs|jsx|tsx?)$/i.test(f) && f !== "tools/check.mjs"));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, domestic, global, problems } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  if (!existsSync(join(root, "docs/build/sources.md"))) errors.push("docs/build/sources.md 없음");
  else {
    const src = read("docs/build/sources.md");
    errors.push(...checkDomestic(domestic, parseSources(src)), ...checkGlobal(global, src));
  }
  errors.push(...checkGraduation(read("tutor/assessment.md")));
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 파일 ${files.length}개 검사`);
}

main();
