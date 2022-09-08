import type { RawModuleRuleUse, RawModuleRule } from "@rspack/binding";
import assert from "node:assert";

export interface ModuleRule {
	test?: RawModuleRule["test"];
	resource?: RawModuleRule["resource"];
	resourceQuery?: RawModuleRule["resourceQuery"];
	uses?: ModuleRuleUse[];
	type?: RawModuleRule["type"];
}

export interface Module {
	rules?: ModuleRule[];
	parser?: {
		dataUrlCondition?: {
			maxSize?: number;
		};
	};
}

interface ResolvedModuleRule {
	test?: RawModuleRule["test"];
	resource?: RawModuleRule["resource"];
	resourceQuery?: RawModuleRule["resourceQuery"];
	uses?: RawModuleRuleUse[];
	type?: RawModuleRule["type"];
}

export interface ResolvedModule {
	rules: ResolvedModuleRule[];
	parser?: {
		dataUrlCondition: {
			maxSize: number;
		};
	};
}

interface LoaderContextInternal {
	// TODO: It's not a good way to do this, we should split the `source` into a separate type and avoid using `serde_json`, but it's a temporary solution.
	source: number[];
	resource: String;
	resourcePath: String;
	resourceQuery: String | null;
	resourceFragment: String | null;
}

interface LoaderResult {
	content: Buffer | string;
	meta: Buffer | string;
}

interface LoaderThreadsafeResult {
	id: number;
	p: LoaderResultInternal | null | undefined;
}

interface LoaderResultInternal {
	content: number[];
	meta: number[];
}

interface LoaderContext
	extends Pick<
		LoaderContextInternal,
		"resource" | "resourcePath" | "resourceQuery" | "resourceFragment"
	> {
	source: {
		getCode(): string;
		getBuffer(): Buffer;
	};
}

const toBuffer = (bufLike: string | Buffer): Buffer => {
	if (Buffer.isBuffer(bufLike)) {
		return bufLike;
	} else if (typeof bufLike === "string") {
		return Buffer.from(bufLike);
	}

	throw new Error("Buffer or string expected");
};

interface LoaderThreadsafeContext {
	id: number;
	p: LoaderContextInternal;
}

function composeJsUse(uses: ModuleRuleUse[]): RawModuleRuleUse | null {
	if (!uses.length) {
		return null;
	}

	async function loader(err: any, data: Buffer): Promise<Buffer> {
		if (err) {
			throw err;
		}

		const loaderThreadsafeContext: LoaderThreadsafeContext = JSON.parse(
			data.toString("utf-8")
		);

		const { p: payload, id } = loaderThreadsafeContext;

		const loaderContextInternal: LoaderContextInternal = {
			source: payload.source,
			resourcePath: payload.resourcePath,
			resourceQuery: payload.resourceQuery,
			resource: payload.resource,
			resourceFragment: payload.resourceFragment
		};

		let sourceBuffer = Buffer.from(loaderContextInternal.source);
		let meta = Buffer.from("");
		// Loader is executed from right to left
		for (const use of uses) {
			assert("loader" in use);
			const loaderContext = {
				...loaderContextInternal,
				source: {
					getCode(): string {
						return sourceBuffer.toString("utf-8");
					},
					getBuffer(): Buffer {
						return sourceBuffer;
					}
				},
				getOptions() {
					return use.options;
				}
			};

			let loaderResult: LoaderResult;
			if (
				(loaderResult = await Promise.resolve().then(() =>
					use.loader.apply(loaderContext, [loaderContext])
				))
			) {
				const content = loaderResult.content;
				meta = meta.length > 0 ? meta : toBuffer(loaderResult.meta);
				sourceBuffer = toBuffer(content);
			}
		}

		const loaderResultPayload: LoaderResultInternal = {
			content: [...sourceBuffer],
			meta: [...meta]
		};

		const loaderThreadsafeResult: LoaderThreadsafeResult = {
			id: id,
			p: loaderResultPayload
		};
		return Buffer.from(JSON.stringify(loaderThreadsafeResult), "utf-8");
	}
	loader.displayName = `NodeLoaderAdapter(${uses
		.map(item => {
			assert("loader" in item);
			return item.loader.displayName || item.loader.name || "unknown-loader";
		})
		.join(" -> ")})`;
	return {
		loader
	};
}

interface JsLoader {
	(this: LoaderContext, loaderContext: LoaderContext):
		| Promise<LoaderResult | void>
		| LoaderResult
		| void;
	displayName?: string;
}

type BuiltinLoader = string;

type ModuleRuleUse =
	| {
			builtinLoader: BuiltinLoader;
			options?: unknown;
	  }
	| {
			loader: JsLoader;
			options?: unknown;
	  };

export function createRawModuleRuleUses(
	uses: ModuleRuleUse[]
): RawModuleRuleUse[] {
	return createRawModuleRuleUsesImpl([...uses].reverse());
}

function createRawModuleRuleUsesImpl(
	uses: ModuleRuleUse[]
): RawModuleRuleUse[] {
	if (!uses.length) {
		return [];
	}

	const index = uses.findIndex(use => "builtinLoader" in use);
	if (index < 0) {
		return [composeJsUse(uses)];
	}

	const before = uses.slice(0, index);
	const after = uses.slice(index + 1);
	return [
		composeJsUse(before),
		createNativeUse(uses[index]),
		...createRawModuleRuleUsesImpl(after)
	].filter((item): item is RawModuleRuleUse => Boolean(item));
}

function createNativeUse(use: ModuleRuleUse): RawModuleRuleUse {
	assert("builtinLoader" in use);

	if (use.builtinLoader === "sass-loader") {
		(use.options ??= {} as any).__exePath = require.resolve(
			`@tmp-sass-embedded/${process.platform}-${
				process.arch
			}/dart-sass-embedded/dart-sass-embedded${
				process.platform === "win32" ? ".bat" : ""
			}`
		);
	}

	return {
		builtinLoader: use.builtinLoader,
		options: JSON.stringify(use.options)
	};
}

export function resolveModuleOptions(module: Module = {}): ResolvedModule {
	const rules = (module.rules ?? []).map(rule => ({
		...rule,
		uses: createRawModuleRuleUses(rule.uses || [])
	}));
	return {
		rules
	};
}
