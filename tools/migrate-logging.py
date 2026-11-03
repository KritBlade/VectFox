#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
migrate-logging.py — byte-safe console.* -> log.* migrator for VectFox.

WHY THIS EXISTS
  The logging standard (plans/logging-levels-and-classification.md + core/log.js)
  requires every console.* call to route through the `log` helper, with levels
  chosen BY CALL FREQUENCY, not topic. Doing this by hand is error-prone, and on
  CRLF + multibyte (Chinese) files an editor/Read layer can garble the bytes.
  This tool operates on the raw file bytes (utf-8, newline='') so line endings
  and multibyte text are preserved exactly.

WORKFLOW (two steps, human keeps the judgment calls)
  1) DRY RUN  ->  writes a review plan you edit:
         python tools/migrate-logging.py backends/standard.js
     Mechanical swaps (error/warn/info/debug, import, idempotency) need no
     decision and are summarised in the plan header. JUDGMENT rows --
     console.log level, dead-flag gate level, and SECRET-looking args -- are
     listed for you to set.

  2) APPLY  ->  consumes the (edited) plan, transforms, self-verifies:
         python tools/migrate-logging.py backends/standard.js --apply
     Builds the new file in memory and writes ONLY if 0 console.* remain AND
     `node --check` passes. A bad run rolls back; the file is left untouched.

SAFETY
  * Refuses files that must never be migrated (log.js helper, vendored code,
    tests, tools, *.min.js).
  * Never auto-redacts secrets. SECRET-flagged rows must be resolved
    (keep | drop) or apply refuses. To redact, set keep then hand-edit args.
  * Idempotent: re-running on a migrated file is a no-op.

completed migrated file
backend-registry.js
qdrant.js
bm25-scorer.js
settings-panel.js
eventbase-workflow.js
eventbase-retrieval.js
eventbase-store.js
collection-loader.js
hybrid-search.js
keyword-boost.js
standard.js
agentic-retrieval.js
api-keys.js
collection-export.js
collection-metadata.js
conditional-activation.js
content-vectorization.js
vector-api.js
corpus-stats.js
png-export.js
world-info-integration.js
collection-ids.js
lorebook-rename-detector.js
query-keyword-extractor.js
text-cleaning.js
tokenizer-lock.js
diagnostics-runner.js
chunk-visualizer.js


"""

import argparse
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAN_DIR = os.path.join(REPO_ROOT, "tools", "logmig-plans")

# Files/dirs that must NEVER be migrated.
SKIP_RE = re.compile(
    r"(^|/)(node_modules|tests|dist|tools|scripts|vendor)/"
    r"|(^|/)core/log\.js$"
    r"|\.min\.js$"
)

# Dead, UI-removed gate flags that are stuck-on and spam the console.
# (User decision 2026-05-30: no migration shim; these are not read anymore.)
DEAD_FLAGS = ["eventbase_debug_logging"]

def propose_level(code: str) -> str:
    c = code.lower()
    if "timing" in c or "total=" in c or "elapsed" in c or "per-batch" in c:
        return "verbose"                       # per-batch / per-window timing
    if "preview" in c or "per-item" in c or "pixel" in c:
        return "trace"                         # per-item detail
    if "batch" in c and "completed" in c:
        return "verbose"
    return "lifecycle"                         # O(1)/run state changes (default)

# Credential indicators. Word-boundary regexes so vocabulary like "tokenizer",
# "tokenization", "tokens" (BM25/CJK terms) never trips the SECRET flag -- only
# real credential words do. Each entry is (label, compiled-regex).
SECRET_HINTS = [
    ("apikey", re.compile(r"\bapi[_-]?key\b", re.I)),
    ("token", re.compile(r"\b(access|auth|refresh|bearer|id)[_-]?token\b", re.I)),
    ("secret", re.compile(r"\bsecret\b", re.I)),
    ("password", re.compile(r"\bpass(word|wd)\b", re.I)),
    ("authorization", re.compile(r"\bauthorization\b", re.I)),
    ("bearer", re.compile(r"\bbearer\b", re.I)),
    ("credential", re.compile(r"\bcredential", re.I)),
    ("stringify(config", re.compile(r"json\.stringify\(\s*config", re.I)),
    ("stringify(body", re.compile(r"json\.stringify\(\s*body", re.I)),
    ("getRequestHeaders", re.compile(r"getRequestHeaders", re.I)),
]

def secret_flag(code: str):
    hits = [label for label, rx in SECRET_HINTS if rx.search(code)]
    return ",".join(hits) if hits else ""

CONSOLE_RE = re.compile(r"console\.(log|warn|error|info|debug)\s*\(")
LEVEL_FIXED = {"error": "error", "warn": "warn", "info": "lifecycle", "debug": "trace"}
ALLOWED_LEVELS = {"lifecycle", "verbose", "trace"}

def read_text(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()

def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)

def newline_of(text):
    return "\r\n" if "\r\n" in text else "\n"

def import_line_for(rel_file):
    d = os.path.dirname(rel_file)
    rel = os.path.relpath(os.path.join("core", "log.js"), d if d else ".")
    rel = rel.replace(os.sep, "/")
    if not rel.startswith("."):
        rel = "./" + rel
    return "import {{ log }} from '{}';".format(rel)

def plan_path_for(rel_file):
    flat = rel_file.replace(os.sep, "/").replace("/", "__")
    return os.path.join(PLAN_DIR, flat + ".tsv")

# ----------------------------------------------------------------------------- analyse
def analyse(text):
    lines = text.split("\n")
    rows = []
    summary = {"error": 0, "warn": 0, "info": 0, "debug": 0,
               "gate_if": 0, "gate_const": 0, "import": "import { log }" not in text}
    for i, raw in enumerate(lines, start=1):
        line = raw.rstrip("\r")
        for flag in DEAD_FLAGS:
            if re.search(r"if\s*\(\s*settings\??\.%s\s*\)" % re.escape(flag), line):
                rows.append({"line": i, "kind": "gate-if", "level": "verbose",
                             "action": "-", "secret": "", "code": line.strip()})
                summary["gate_if"] += 1
            if re.search(r"const\s+\w+\s*=\s*settings\??\.%s\s*;" % re.escape(flag), line):
                rows.append({"line": i, "kind": "gate-const", "level": "lifecycle",
                             "action": "-", "secret": "", "code": line.strip()})
                summary["gate_const"] += 1
        for m in CONSOLE_RE.finditer(line):
            method = m.group(1)
            sec = secret_flag(line)
            if method == "log":
                rows.append({"line": i, "kind": "log", "level": propose_level(line),
                             "action": ("review" if sec else "-"),
                             "secret": sec, "code": line.strip()})
            else:
                summary[method] += 1
                if sec:
                    rows.append({"line": i, "kind": "log-" + method,
                                 "level": LEVEL_FIXED[method], "action": "review",
                                 "secret": sec, "code": line.strip()})
    return rows, summary

# ----------------------------------------------------------------------------- plan io
def write_plan(rel_file, rows, summary):
    os.makedirs(PLAN_DIR, exist_ok=True)
    p = plan_path_for(rel_file)
    o = []
    o.append("# Logging migration plan for: %s" % rel_file)
    o.append("#")
    o.append("# AUTO (applied as-is, no decision needed):")
    o.append("#   console.error x%d -> log.error" % summary["error"])
    o.append("#   console.warn  x%d -> log.warn" % summary["warn"])
    if summary["info"]:
        o.append("#   console.info  x%d -> log.lifecycle" % summary["info"])
    if summary["debug"]:
        o.append("#   console.debug x%d -> log.trace" % summary["debug"])
    if summary["import"]:
        o.append("#   import { log } -> inserted after last import")
    o.append("#")
    o.append("# EDIT BELOW:")
    o.append("#   kind=log / gate-* : set LEVEL to one of lifecycle|verbose|trace")
    o.append("#   ACTION=review     : SECRET-looking args; set ACTION to keep|drop")
    o.append("#                       keep=swap with original args, drop=delete stmt.")
    o.append("#                       To redact, set keep and hand-edit args after.")
    o.append("#")
    o.append("# Then: python tools/migrate-logging.py %s --apply" % rel_file)
    o.append("#")
    o.append("\t".join(["LINE", "KIND", "LEVEL", "ACTION", "SECRET", "CODE"]))
    for r in rows:
        o.append("\t".join([str(r["line"]), r["kind"], r["level"],
                            r["action"], r["secret"] or "-", r["code"]]))
    write_text(p, "\n".join(o) + "\n")
    return p

def read_plan(rel_file):
    p = plan_path_for(rel_file)
    if not os.path.exists(p):
        return None
    rows = []
    for ln in read_text(p).split("\n"):
        if not ln.strip() or ln.startswith("#") or ln.startswith("LINE\t"):
            continue
        parts = ln.rstrip("\r").split("\t")
        if len(parts) < 5:
            continue
        rows.append({"line": int(parts[0]), "kind": parts[1], "level": parts[2].strip(),
                     "action": parts[3].strip(), "secret": parts[4].strip(),
                     "code": "\t".join(parts[5:])})
    return rows

# ----------------------------------------------------------------------------- apply
def apply(rel_file, path, text):
    rows = read_plan(rel_file)
    if rows is None:
        sys.exit("No plan found. Dry run first: python tools/migrate-logging.py %s" % rel_file)
    errs = []
    for r in rows:
        if r["kind"] in ("log", "gate-if", "gate-const") and r["level"] not in ALLOWED_LEVELS:
            errs.append("line %d: LEVEL '%s' invalid" % (r["line"], r["level"]))
        if r["action"] == "review":
            errs.append("line %d: SECRET unresolved (keep|drop): %s" % (r["line"], r["secret"]))
        if r["action"] not in ("-", "keep", "drop"):
            errs.append("line %d: ACTION '%s' invalid" % (r["line"], r["action"]))
    if errs:
        sys.exit("Plan not ready:\n  " + "\n  ".join(errs))

    lines = text.split("\n")
    by_line = {}
    for r in rows:
        by_line.setdefault(r["line"], []).append(r)
    for lineno, rs in by_line.items():
        idx = lineno - 1
        cur = lines[idx]
        for r in rs:
            if r["action"] == "drop":
                cur = None
                break
            if r["kind"] == "gate-if":
                for flag in DEAD_FLAGS:
                    cur = re.sub(r"if\s*\(\s*settings\??\.%s\s*\)" % re.escape(flag),
                                 "if (log.enabled('%s'))" % r["level"], cur)
            elif r["kind"] == "gate-const":
                for flag in DEAD_FLAGS:
                    cur = re.sub(r"=\s*settings\??\.%s\s*;" % re.escape(flag),
                                 "= log.enabled('%s');" % r["level"], cur)
            elif r["kind"] == "log":
                cur = cur.replace("console.log(", "log.%s(" % r["level"], 1)
            elif r["kind"].startswith("log-"):
                method = r["kind"].split("-", 1)[1]
                cur = cur.replace("console.%s(" % method, "log.%s(" % LEVEL_FIXED[method], 1)
        lines[idx] = cur
    lines = [l for l in lines if l is not None]

    text2 = "\n".join(lines)
    text2 = text2.replace("console.error(", "log.error(")
    text2 = text2.replace("console.warn(", "log.warn(")
    text2 = text2.replace("console.info(", "log.lifecycle(")
    text2 = text2.replace("console.debug(", "log.trace(")

    if "import { log }" not in text2:
        imp = import_line_for(rel_file)
        l2 = text2.split("\n")
        last = -1
        for i, l in enumerate(l2):
            if re.match(r"\s*import\s.+from\s.+;", l.rstrip("\r")):
                last = i
        if last < 0:
            sys.exit("No existing import to anchor the log import.")
        cr = "\r" if l2[last].endswith("\r") else ""
        l2.insert(last + 1, imp + cr)
        text2 = "\n".join(l2)

    left = CONSOLE_RE.findall(text2)
    if left:
        sys.exit("Refusing to write: %d console.* still present %s" % (len(left), set(left)))

    write_text(path, text2)
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if r.returncode != 0:
        write_text(path, text)
        sys.exit("node --check FAILED, rolled back:\n" + r.stderr)
    print("APPLIED %s  (node --check OK, 0 console.* left)" % rel_file)

# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Byte-safe console.* -> log.* migrator")
    ap.add_argument("file", help="target .js file (path relative to repo root)")
    ap.add_argument("--apply", action="store_true", help="consume the edited plan and migrate")
    args = ap.parse_args()

    rel_file = os.path.relpath(os.path.abspath(args.file), REPO_ROOT).replace(os.sep, "/")
    if SKIP_RE.search(rel_file):
        sys.exit("REFUSED: %s is on the never-migrate list (log.js / vendor / tests / tools / min)." % rel_file)
    path = os.path.join(REPO_ROOT, rel_file)
    if not os.path.exists(path):
        sys.exit("No such file: " + rel_file)
    text = read_text(path)

    if args.apply:
        apply(rel_file, path, text)
        return

    rows, summary = analyse(text)
    n_log = sum(1 for r in rows if r["kind"] == "log")
    if (summary["error"] + summary["warn"] + summary["info"] + summary["debug"]
            + n_log + summary["gate_if"] + summary["gate_const"]) == 0:
        print("Nothing to do: %s has 0 console.* and 0 dead-flag gates." % rel_file)
        return
    p = write_plan(rel_file, rows, summary)
    print("DRY RUN %s" % rel_file)
    print("  auto:   error=%d warn=%d info=%d debug=%d import=%s"
          % (summary["error"], summary["warn"], summary["info"], summary["debug"], summary["import"]))
    print("  review: %d console.log, %d gate-if, %d gate-const, %d secret-flagged"
          % (n_log, summary["gate_if"], summary["gate_const"],
             sum(1 for r in rows if r["action"] == "review")))
    print("  plan -> %s" % os.path.relpath(p, REPO_ROOT).replace(os.sep, "/"))
    print("  edit LEVEL/ACTION, then re-run with --apply")

if __name__ == "__main__":
    main()
