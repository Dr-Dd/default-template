/**
 * Unit-level change detection for check-guard.
 *
 * A file is split with tree-sitter into "units": named definitions (functions, classes, methods,
 * test blocks such as `describe`/`it`), plus anonymous statements (imports, constants, setup code).
 * Every non-comment token of a file belongs to exactly one unit or anonymous statement, so any
 * change to code that existed in the base commit is detected:
 *
 * - a base unit whose content changes, or that is removed or renamed, is flagged;
 * - a base anonymous statement that disappears (changed or removed) is flagged;
 * - new units and statements are allowed, except "sensitive" ones that change how existing tests
 *   run (focused tests, new hooks in existing suites, pytest hooks, autouse fixtures, module mocks)
 *   and new definitions that reuse the name of a base unit in the same scope (they may override it).
 *
 * Changes are judged step by step: a unit is flagged when it differs between the current file and
 * the proposed file, so a change the user already approved is not asked about again.
 * Containers (classes, `describe` blocks, modules) are hashed without their members, so adding a
 * method to an existing class or a test to an existing suite is not a change of the container.
 * Hashes cover the syntax tree (types and token text), not whitespace, so reformatting is ignored
 * while Python indentation changes (which change the tree) are not.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { extname, join } from "node:path";

/** The subset of web-tree-sitter's Node used here. */
interface TSNode {
	id: number;
	type: string;
	isExtra: boolean;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number };
	childCount: number;
	children: TSNode[];
	namedChildren: TSNode[];
	text: string;
	childForFieldName(name: string): TSNode | null;
}
interface TSTree {
	rootNode: TSNode & { hasError: boolean };
	delete(): void;
}
interface TSParser {
	setLanguage(lang: unknown): void;
	parse(src: string): TSTree | null;
}
interface TSModule {
	Parser: { init(): Promise<void>; new (): TSParser };
	Language: { load(path: string): Promise<unknown> };
}

type Classified = {
	kind: "container" | "leaf";
	name: string;
	/** Container members (judged on their own; excluded from the container's hash). */
	members?: TSNode[];
	/** Setup/teardown hook: sensitive when added to a container that existed in the base commit. */
	hook?: boolean;
	/** Always sensitive when added or changed, with the reason. */
	focus?: string;
};

export interface Preset {
	/** Grammar .wasm, relative to node_modules, for a file path. */
	grammar(rel: string, override?: string): string;
	classify(node: TSNode): Classified | undefined;
	/** Node types folded into the unit that follows them (e.g. Rust `#[test]`). */
	attach?: ReadonlySet<string>;
	/** Whether a comment counts as code. Default: only tool directives (`@ts-`, `noqa`, ...). */
	keepComment?(node: TSNode): boolean;
	/** New anonymous statements matching this are sensitive (e.g. module-level mocks). */
	anonSensitive?: RegExp;
}

/** Comments that change what tools do (type checkers, linters, coverage). */
const DIRECTIVE =
	/@ts-|eslint|noqa|type:\s*ignore|pragma|istanbul|\bc8\b|nolint|prettier-ignore|biome-ignore|deno-|pylint|mypy|ruff|fmt:|go:|clippy|rustfmt|NOSONAR|@jest-environment|@vitest-environment/i;

const field = (n: TSNode, f: string) => n.childForFieldName(f);
const nameOf = (n: TSNode, f = "name") => field(n, f)?.text;

/** Names of the `name` fields of a node's named children (declarators, specs). */
function declaredNames(n: TSNode): string | undefined {
	const names = n.namedChildren.map((c) => nameOf(c)).filter((s): s is string => !!s);
	return names.length ? names.join(",") : undefined;
}

// ---------------------------------------------------------------- Python (pytest/unittest)

const PY_HOOKS = new Set([
	"setUp",
	"tearDown",
	"setUpClass",
	"tearDownClass",
	"setUpModule",
	"tearDownModule",
	"setup_method",
	"teardown_method",
	"setup_function",
	"teardown_function",
	"setup_module",
	"teardown_module",
	"setup_class",
	"teardown_class",
	"setup",
	"teardown",
]);

const pytest: Preset = {
	grammar: () => "tree-sitter-python/tree-sitter-python.wasm",
	classify(node) {
		if (node.type === "expression_statement") {
			// `NAME = ...` / `NAME: T = ...`: a later assignment to the same name overrides it.
			const a = node.namedChildren[0];
			const left = a?.type === "assignment" ? field(a, "left") : undefined;
			if (!left) return undefined;
			const focus = /^(pytestmark|collect_ignore(_glob)?|pytest_plugins)$/.test(left.text) ? left.text : undefined;
			return { kind: "leaf", name: `${left.text} =`, focus };
		}
		const def = node.type === "decorated_definition" ? field(node, "definition") : node;
		if (!def) return undefined;
		const name = nameOf(def);
		if (!name) return undefined;
		if (def.type === "function_definition") {
			const focus = name.startsWith("pytest_")
				? `pytest hook ${name}`
				: /autouse\s*=\s*True/.test(node.text)
					? `autouse fixture ${name}`
					: undefined;
			return { kind: "leaf", name, hook: PY_HOOKS.has(name), focus };
		}
		if (def.type === "class_definition") {
			return { kind: "container", name, members: field(def, "body")?.namedChildren ?? [] };
		}
		return undefined;
	},
	anonSensitive: /\bpytestmark\b|\bpytest\s*\.\s*(skip|xfail|importorskip)\s*\(|\bcollect_ignore/,
};

// ---------------------------------------------------------------- JS/TS (jest, vitest, mocha, node:test, playwright)

const JS_SUITES = new Set(["describe", "context", "suite", "fdescribe", "xdescribe", "xcontext"]);
const JS_TESTS = new Set(["it", "test", "specify", "fit", "xit", "xtest", "xspecify", "bench"]);
const JS_HOOKS = new Set([
	"before",
	"after",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
	"setup",
	"teardown",
	"suiteSetup",
	"suiteTeardown",
]);

/** Test-framework call (`describe(...)`, `it.only.each(t)(...)`, `test.describe(...)`, hooks). */
function jsCall(call: TSNode): Classified | undefined {
	const parts: string[] = [];
	let fn = field(call, "function");
	while (fn) {
		if (fn.type === "identifier") {
			parts.unshift(fn.text);
			break;
		}
		if (fn.type === "member_expression") {
			parts.unshift(nameOf(fn, "property") ?? "?");
			fn = field(fn, "object");
		} else if (fn.type === "call_expression") fn = field(fn, "function");
		else return undefined;
	}
	// Playwright-style `test.describe`, `test.beforeEach`.
	let base = parts[0];
	if (base === "test" && parts[1] && (JS_SUITES.has(parts[1]) || JS_HOOKS.has(parts[1]))) base = parts[1];
	if (!base || !(JS_SUITES.has(base) || JS_TESTS.has(base) || JS_HOOKS.has(base))) return undefined;

	const args = field(call, "arguments")?.namedChildren ?? [];
	const title = args.find((a) => a.type === "string" || a.type === "template_string")?.text;
	const name = title ? `${base}(${title})` : base;
	const focus =
		parts.includes("only") || base === "fit" || base === "fdescribe" ? `focused test ${name}` : undefined;
	if (JS_HOOKS.has(base)) return { kind: "leaf", name, hook: true, focus };
	if (JS_SUITES.has(base)) {
		const fnArg = [...args].reverse().find((a) => /^(arrow_function|function_expression|function)$/.test(a.type));
		const body = fnArg && field(fnArg, "body");
		if (body?.type === "statement_block") return { kind: "container", name, members: body.namedChildren, focus };
	}
	return { kind: "leaf", name, focus };
}

const JS_LEAF_DECLS = new Set([
	"function_declaration",
	"generator_function_declaration",
	"function_signature",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"method_definition",
	"method_signature",
	"abstract_method_signature",
]);

function jsClassify(node: TSNode): Classified | undefined {
	switch (node.type) {
		case "export_statement": {
			const decl = field(node, "declaration");
			return decl ? jsClassify(decl) : undefined;
		}
		case "expression_statement": {
			const call = node.namedChildren[0];
			return call?.type === "call_expression" ? jsCall(call) : undefined;
		}
		case "class_declaration":
		case "abstract_class_declaration":
		case "internal_module":
		case "module": {
			const name = nameOf(node);
			const body = field(node, "body");
			return name && body ? { kind: "container", name, members: body.namedChildren } : undefined;
		}
		case "lexical_declaration":
		case "variable_declaration": {
			const name = declaredNames(node);
			return name ? { kind: "leaf", name } : undefined;
		}
		case "public_field_definition":
		case "field_definition": {
			const name = nameOf(node) ?? nameOf(node, "property");
			return name ? { kind: "leaf", name } : undefined;
		}
	}
	if (JS_LEAF_DECLS.has(node.type)) {
		const name = nameOf(node);
		return name ? { kind: "leaf", name } : undefined;
	}
	return undefined;
}

const jest: Preset = {
	grammar(rel) {
		const ext = extname(rel).toLowerCase();
		if (ext === ".tsx") return "tree-sitter-typescript/tree-sitter-tsx.wasm";
		if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "tree-sitter-typescript/tree-sitter-typescript.wasm";
		return "tree-sitter-javascript/tree-sitter-javascript.wasm";
	},
	classify: jsClassify,
	anonSensitive:
		/\b(jest|vi|vitest)\s*\.\s*(mock|doMock|unmock|spyOn|stubGlobal|stubEnv|useFakeTimers|setSystemTime|setConfig|retryTimes)\b|\bmock\.module\b/,
};

// ---------------------------------------------------------------- Go

const go: Preset = {
	grammar: () => "tree-sitter-go/tree-sitter-go.wasm",
	classify(node) {
		if (node.type === "function_declaration") {
			const name = nameOf(node);
			if (!name) return undefined;
			const focus = name === "TestMain" ? "TestMain" : name === "init" ? "init function" : undefined;
			return { kind: "leaf", name, focus };
		}
		if (node.type === "method_declaration") {
			const recv = field(node, "receiver")?.namedChildren[0];
			const type = recv && field(recv, "type")?.text.replace(/^\*/, "");
			const name = nameOf(node);
			return name ? { kind: "leaf", name: type ? `${type}.${name}` : name } : undefined;
		}
		if (/^(type|const|var)_declaration$/.test(node.type)) {
			const name = declaredNames(node);
			return name ? { kind: "leaf", name } : undefined;
		}
		return undefined;
	},
	// `// Output:` comments are assertions in Example tests; build tags and directives change what is compiled.
	keepComment: (n) => /^\/\/\s*(Output:|Unordered output:|\+build|go:)/i.test(n.text) || DIRECTIVE.test(n.text),
};

// ---------------------------------------------------------------- Rust

const RUST_LEAF = new Set([
	"function_item",
	"function_signature_item",
	"struct_item",
	"enum_item",
	"union_item",
	"const_item",
	"static_item",
	"type_item",
	"macro_definition",
]);

const rust: Preset = {
	grammar: () => "tree-sitter-rust/tree-sitter-rust.wasm",
	classify(node) {
		if (RUST_LEAF.has(node.type)) {
			const name = nameOf(node);
			return name ? { kind: "leaf", name } : undefined;
		}
		if (node.type === "mod_item" || node.type === "trait_item" || node.type === "impl_item") {
			const name =
				node.type === "impl_item"
					? `impl ${field(node, "trait") ? `${field(node, "trait")!.text} for ` : ""}${nameOf(node, "type") ?? "?"}`
					: nameOf(node);
			if (!name) return undefined;
			const body = field(node, "body");
			return body ? { kind: "container", name, members: body.namedChildren } : { kind: "leaf", name };
		}
		return undefined;
	},
	attach: new Set(["attribute_item"]),
	// Doc comments hold doctests.
	keepComment: (n) => /^(\/\/\/|\/\/!|\/\*\*(?!\/)|\/\*!)/.test(n.text) || DIRECTIVE.test(n.text),
};

// ---------------------------------------------------------------- Java (JUnit, TestNG)

const JAVA_HOOK = /@(Before|After)(Each|All|Class|Method|Suite|Test|Groups)?\b|@(Class)?Rule\b|@RegisterExtension\b/;

const junit: Preset = {
	grammar: () => "tree-sitter-java/tree-sitter-java.wasm",
	classify(node) {
		switch (node.type) {
			case "class_declaration":
			case "interface_declaration":
			case "enum_declaration":
			case "record_declaration":
			case "annotation_type_declaration": {
				const name = nameOf(node);
				const body = field(node, "body");
				return name && body ? { kind: "container", name, members: body.namedChildren } : undefined;
			}
			case "method_declaration":
			case "constructor_declaration": {
				const name = nameOf(node);
				if (!name) return undefined;
				const params = (field(node, "parameters")?.namedChildren ?? [])
					.map((p) => nameOf(p, "type") ?? p.type)
					.join(",");
				const mods = node.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
				return { kind: "leaf", name: `${name}(${params})`, hook: JAVA_HOOK.test(mods) };
			}
			case "field_declaration": {
				const name = declaredNames(node);
				const mods = node.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
				return name ? { kind: "leaf", name, hook: JAVA_HOOK.test(mods) } : undefined;
			}
		}
		return undefined;
	},
};

// ---------------------------------------------------------------- Lua (busted)

const LUA_SUITES = new Set(["describe", "context", "insulate", "expose"]);
const LUA_TESTS = new Set(["it", "spec", "test", "pending"]);
const LUA_HOOKS = new Set([
	"before_each",
	"after_each",
	"setup",
	"teardown",
	"lazy_setup",
	"lazy_teardown",
	"strict_setup",
	"strict_teardown",
	"finally",
]);

const busted: Preset = {
	grammar: () => "@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm",
	classify(node) {
		if (node.type === "function_declaration") {
			const name = nameOf(node);
			return name ? { kind: "leaf", name } : undefined;
		}
		if (node.type === "variable_declaration" || node.type === "assignment_statement") {
			const inner = node.type === "variable_declaration" ? node.namedChildren[0] : node;
			const list = inner?.namedChildren.find((c) => c.type === "variable_list");
			const name = list?.text;
			return name ? { kind: "leaf", name } : undefined;
		}
		if (node.type !== "function_call") return undefined;
		const base = nameOf(node);
		if (!base || !(LUA_SUITES.has(base) || LUA_TESTS.has(base) || LUA_HOOKS.has(base))) return undefined;
		const args = field(node, "arguments")?.namedChildren ?? [];
		const title = args.find((a) => a.type === "string")?.text;
		const name = title ? `${base}(${title})` : base;
		if (LUA_HOOKS.has(base)) return { kind: "leaf", name, hook: true };
		if (LUA_SUITES.has(base)) {
			const fn = [...args].reverse().find((a) => a.type === "function_definition");
			const body = fn && field(fn, "body");
			return { kind: "container", name, members: body?.namedChildren ?? [] };
		}
		return { kind: "leaf", name };
	},
};

// ---------------------------------------------------------------- generic

/** Any grammar: each top-level node with a `name` field is a unit, everything else a statement. */
const generic: Preset = {
	grammar(_rel, override) {
		if (!override) throw new Error('the "generic" preset needs a "grammar" (e.g. "tree-sitter-c/tree-sitter-c.wasm")');
		return override;
	},
	classify(node) {
		const name = nameOf(node);
		return name ? { kind: "leaf", name: `${node.type} ${name}` } : undefined;
	},
};

export const PRESETS: Record<string, Preset> = {
	pytest,
	python: pytest,
	jest,
	vitest: jest,
	mocha: jest,
	javascript: jest,
	typescript: jest,
	go,
	rust,
	junit,
	java: junit,
	busted,
	lua: busted,
	generic,
};

// ---------------------------------------------------------------- extraction

export interface Unit {
	key: string;
	hash: string;
	/** 1-based line. */
	line: number;
	/** Key of the enclosing container ("" for the file). */
	parent: string;
	hook: boolean;
	focus?: string;
}

export interface Statement {
	hash: string;
	line: number;
	preview: string;
}

export interface Extracted {
	units: Map<string, Unit>;
	/** Anonymous statements per container key. */
	statements: Map<string, Statement[]>;
	hasError: boolean;
}

/** Key of the file's own unit: the top-level tokens that belong to no statement. */
const FILE_KEY = "";

function serialize(nodes: TSNode[], src: string, preset: Preset, skip?: ReadonlySet<number>): string {
	const keep = preset.keepComment ?? ((n: TSNode) => DIRECTIVE.test(n.text));
	const out: string[] = [];
	const walk = (n: TSNode) => {
		if (skip?.has(n.id)) return;
		if (n.type.includes("comment") && !keep(n)) return;
		if (n.childCount === 0) {
			out.push(src.slice(n.startIndex, n.endIndex));
			return;
		}
		out.push(`(${n.type}`);
		const stringy = n.type.includes("string") || n.type.includes("heredoc");
		let prev = n.startIndex;
		const gap = (end: number) => {
			const g = src.slice(prev, end);
			if (g && (stringy || g.trim())) out.push(`~${g}`);
		};
		for (const c of n.children) {
			gap(c.startIndex);
			walk(c);
			prev = c.endIndex;
		}
		gap(n.endIndex);
		out.push(")");
	};
	for (const n of nodes) walk(n);
	return createHash("sha1").update(out.join("\u0000")).digest("hex");
}

export function extract(tree: TSTree, src: string, preset: Preset): Extracted {
	const units = new Map<string, Unit>();
	const statements = new Map<string, Statement[]>();
	const root = tree.rootNode;
	const isComment = (n: TSNode) => n.type.includes("comment");
	const keep = preset.keepComment ?? ((n: TSNode) => DIRECTIVE.test(n.text));

	const visit = (members: TSNode[], parent: string) => {
		const used = new Map<string, number>();
		let pending: TSNode[] = [];
		const flush = (nodes: TSNode[]) => {
			if (!nodes.length) return;
			const list = statements.get(parent) ?? [];
			list.push({
				hash: serialize(nodes, src, preset),
				line: nodes[0].startPosition.row + 1,
				preview: nodes.map((n) => n.text).join("\n"),
			});
			statements.set(parent, list);
		};
		for (const m of members) {
			if (isComment(m) && !keep(m)) continue;
			if (preset.attach?.has(m.type)) {
				pending.push(m);
				continue;
			}
			const nodes = [...pending, m];
			pending = [];
			const c = preset.classify(m);
			if (!c) {
				flush(nodes);
				continue;
			}
			const n = (used.get(c.name) ?? 0) + 1;
			used.set(c.name, n);
			const own = n === 1 ? c.name : `${c.name}#${n}`;
			const key = parent ? `${parent}.${own}` : own;
			const skip = c.kind === "container" ? new Set((c.members ?? []).map((x) => x.id)) : undefined;
			units.set(key, {
				key,
				hash: serialize(nodes, src, preset, skip),
				line: nodes[0].startPosition.row + 1,
				parent,
				hook: !!c.hook,
				focus: c.focus,
			});
			if (c.kind === "container") visit(c.members ?? [], key);
		}
		flush(pending);
	};

	const top = root.namedChildren;
	units.set(FILE_KEY, {
		key: FILE_KEY,
		hash: serialize([root], src, preset, new Set(top.map((x) => x.id))),
		line: 1,
		parent: FILE_KEY,
		hook: false,
	});
	visit(top, FILE_KEY);
	return { units, statements, hasError: root.hasError };
}

// ---------------------------------------------------------------- comparison

export interface Issue {
	line: number;
	text: string;
}

const label = (key: string) => (key === FILE_KEY ? "file-level syntax" : key);
const counts = (list: Statement[] | undefined) => {
	const m = new Map<string, Statement[]>();
	for (const s of list ?? []) m.set(s.hash, [...(m.get(s.hash) ?? []), s]);
	return m;
};
const preview = (s: string) => {
	const line = s.split("\n")[0].trim();
	return line.length > 60 ? `${line.slice(0, 57)}...` : line;
};

/**
 * What a change from `cur` to `next` does to code from `base` (undefined: the file is not in the
 * base commit). Empty when the change only adds code. `preset` supplies the sensitive-statement rule.
 */
export function compare(base: Extracted | undefined, cur: Extracted, next: Extracted, preset: Preset): Issue[] {
	const issues: Issue[] = [];
	const baseUnits = base?.units ?? new Map<string, Unit>();

	for (const [key, b] of baseUnits) {
		const c = cur.units.get(key);
		const n = next.units.get(key);
		if (c?.hash === n?.hash || n?.hash === b.hash) continue;
		if (!n) issues.push({ line: c?.line ?? b.line, text: `removes or renames ${label(key)}` });
		else if (!c) issues.push({ line: n.line, text: `redefines ${label(key)}` });
		else issues.push({ line: n.line, text: `modifies ${label(key)}` });
	}

	for (const [parent, list] of base?.statements ?? []) {
		const b = counts(list);
		const c = counts(cur.statements.get(parent));
		const n = counts(next.statements.get(parent));
		for (const [hash, stmts] of b) {
			const keepCur = Math.min(c.get(hash)?.length ?? 0, stmts.length);
			const keepNext = Math.min(n.get(hash)?.length ?? 0, stmts.length);
			if (keepNext < keepCur) {
				const where = parent === FILE_KEY ? "top-level" : `in ${parent}`;
				issues.push({ line: stmts[0].line, text: `changes or removes ${where} statement \`${preview(stmts[0].preview)}\`` });
			}
		}
	}

	const baseExists = base !== undefined;
	const inBase = (key: string) => (key === FILE_KEY ? baseExists : baseUnits.has(key));
	for (const [key, n] of next.units) {
		if (baseUnits.has(key) || cur.units.get(key)?.hash === n.hash) continue;
		// `name#2` next to a base `name` in the same scope: in many languages the later one wins.
		const plain = key.replace(/#\d+$/, "");
		if (plain !== key && baseUnits.has(plain)) {
			issues.push({ line: n.line, text: `adds a second definition of ${plain}` });
		} else if (n.focus) {
			issues.push({ line: n.line, text: `adds ${n.focus}` });
		} else if (n.hook && inBase(n.parent)) {
			issues.push({ line: n.line, text: `adds hook ${key} to existing ${label(n.parent) === "file-level syntax" ? "file" : n.parent}` });
		}
	}

	if (preset.anonSensitive) {
		for (const [parent, list] of next.statements) {
			const c = counts(cur.statements.get(parent));
			for (const [hash, stmts] of counts(list)) {
				const added = stmts.length - (c.get(hash)?.length ?? 0);
				if (added > 0 && preset.anonSensitive.test(stmts[0].preview)) {
					issues.push({ line: stmts[0].line, text: `adds \`${preview(stmts[0].preview)}\`` });
				}
			}
		}
	}

	return issues.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------- loading

/** Directory (relative to the project root) holding the tree-sitter runtime and grammars. */
export const DEPS_DIR = ".pi/check-guard";

type Runtime = { mod: TSModule; modules: string; parsers: Map<string, Promise<TSParser>> };
const runtimes = new Map<string, Promise<Runtime>>();

/** The tree-sitter runtime installed under `<cwd>/.pi/check-guard/node_modules`. Throws if missing. */
async function runtime(cwd: string): Promise<Runtime> {
	const dir = join(cwd, DEPS_DIR);
	let r = runtimes.get(dir);
	if (!r) {
		r = (async () => {
			const req = createRequire(join(dir, "package.json"));
			let mod: TSModule;
			try {
				mod = req("web-tree-sitter") as TSModule;
			} catch {
				throw new Error(`web-tree-sitter is not installed; run ${DEPS_DIR}/setup.sh`);
			}
			await mod.Parser.init();
			return { mod, modules: join(dir, "node_modules"), parsers: new Map() };
		})();
		runtimes.set(dir, r);
		// Retry next time instead of caching a failure (e.g. setup.sh was run meanwhile).
		r.catch(() => runtimes.delete(dir));
	}
	return r;
}

/** One parser per grammar, reused (parsing is synchronous, so calls never overlap). */
async function parserForGrammar(cwd: string, wasm: string): Promise<TSParser> {
	const rt = await runtime(cwd);
	let parser = rt.parsers.get(wasm);
	if (!parser) {
		parser = rt.mod.Language.load(join(rt.modules, wasm)).then(
			(lang) => {
				const p = new rt.mod.Parser();
				p.setLanguage(lang);
				return p;
			},
			(err: unknown) => {
				rt.parsers.delete(wasm);
				const why = err instanceof Error ? err.message : String(err);
				throw new Error(`cannot load grammar ${wasm} (${why}); run ${DEPS_DIR}/setup.sh`);
			},
		);
		rt.parsers.set(wasm, parser);
	}
	return parser;
}

export type Parsed = (src: string) => Extracted;

/** A parse function for files of `rel`'s type. Throws if the runtime or grammar is unavailable. */
export async function parserFor(cwd: string, preset: Preset, rel: string, grammar?: string): Promise<Parsed> {
	const parser = await parserForGrammar(cwd, preset.grammar(rel, grammar));
	return (src: string) => {
		const text = src.replace(/\r\n/g, "\n");
		const tree = parser.parse(text);
		if (!tree) throw new Error("tree-sitter returned no tree");
		try {
			return extract(tree, text, preset);
		} finally {
			tree.delete();
		}
	};
}
