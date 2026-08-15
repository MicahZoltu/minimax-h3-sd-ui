import * as fs from 'node:fs'
import * as path from 'node:path'

// A symbol-level map of the repository: one line per top-level declaration, grouped by file. The point is answering "what already exists here?" without loading the whole tree into context — the map is roughly an order of magnitude smaller than the sources it summarizes.

// The extractor is a heuristic scanner rather than a compiler parse: typescript is a dev-only dependency and node_modules is stripped from the deployed image, so the executor cannot use the compiler API at runtime. Declarations are found by tracking bracket depth over a copy of the source with comments and string/template/regex literals blanked to spaces; the mask stays index-aligned with the original text, which is where emitted signature text comes from. Output conventions match the former compiler-based version: only export/async/static prefixes are rendered, method type parameters are omitted, and variables with non-function initializers reduce to a bare name.

const REPO_MAP_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.mts', '.cts', '.js', '.jsx', '.tsx'])

const EXCLUDED_PATH_SEGMENTS = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'coverage'])

// Test and declaration files describe surface owned elsewhere rather than owning it themselves.
const EXCLUDED_FILE_SUFFIXES = ['.test.ts', '.test.js', '.test.tsx', '.test.jsx', '.test.mts', '.test.cts', '.d.ts']

function isRepoMapExcludedPath(relativePath: string): boolean {
	for (const segment of relativePath.split(/[/\\]/)) {
		if (segment.startsWith('.')) return true
		if (EXCLUDED_PATH_SEGMENTS.has(segment)) return true
	}
	return EXCLUDED_FILE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))
}

const IDENTIFIER_START = /[$A-Za-z_]/
const IDENTIFIER_CHAR = /[$\w]/
const WHITESPACE = /\s/

const DECLARATION_MODIFIERS = new Set(['export', 'default', 'declare', 'abstract', 'async'])
const DECLARATION_KEYWORDS = new Set(['function', 'class', 'interface', 'enum', 'type', 'const', 'let', 'var'])
const MEMBER_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare'])
const REGEX_OPERAND_ENDERS = new Set([')', ']', '}', "'", '"', '`'])

interface ParseResult {
	symbols: string[]
	end: number
}

function isIdentifierStart(char: string | undefined): boolean {
	return char !== undefined && IDENTIFIER_START.test(char)
}

function isIdentifierChar(char: string | undefined): boolean {
	return char !== undefined && IDENTIFIER_CHAR.test(char)
}

function readWord(mask: string, start: number): { word: string; end: number } {
	let end = start
	while (end < mask.length && isIdentifierChar(mask[end])) end++
	return { word: mask.slice(start, end), end }
}

function skipWhitespace(mask: string, start: number): number {
	let i = start
	while (WHITESPACE.test(mask[i] ?? '')) i++
	return i
}

// Blanks comments and the contents of string/template/regex literals so structural scanning never sees their innards. Literal delimiters stay visible: the mask's whitespace must end where a literal begins, otherwise skipping whitespace after a declarator's `=` would cross a blanked string and adopt the next declaration's signature. A `/` opens a regex literal only when the previous significant character cannot end an operand; the misjudgment risk is accepted because regex bodies can contain braces and quotes that would otherwise corrupt depth tracking.
function maskSource(sourceText: string): string {
	const mask = sourceText.split('')
	let state: 'code' | 'lineComment' | 'blockComment' | 'singleQuote' | 'doubleQuote' | 'template' | 'regex' = 'code'
	const templateInterpolations: number[] = []
	let braceDepth = 0
	let previousSignificant = ''
	let inRegexClass = false
	let i = 0
	function blank(index: number): void {
		if (index < mask.length && mask[index] !== '\n') mask[index] = ' '
	}
	while (i < mask.length) {
		const char = sourceText[i] ?? ''
		const next = sourceText[i + 1] ?? ''
		if (state === 'lineComment') {
			if (char === '\n') state = 'code'
			else blank(i)
			i++
			continue
		}
		if (state === 'blockComment') {
			if (char === '*' && next === '/') {
				blank(i)
				blank(i + 1)
				i += 2
				state = 'code'
				continue
			}
			blank(i)
			i++
			continue
		}
		if (state === 'singleQuote' || state === 'doubleQuote') {
			const quote = state === 'singleQuote' ? "'" : '"'
			if (char === '\\') {
				blank(i)
				blank(i + 1)
				i += 2
				continue
			}
			if (char === quote) {
				state = 'code'
				i++
				continue
			}
			blank(i)
			i++
			if (char === '\n') state = 'code'
			continue
		}
		if (state === 'template') {
			if (char === '\\') {
				blank(i)
				blank(i + 1)
				i += 2
				continue
			}
			if (char === '`') {
				i++
				state = 'code'
				previousSignificant = '`'
				continue
			}
			if (char === '$' && next === '{') {
				blank(i)
				blank(i + 1)
				braceDepth++
				templateInterpolations.push(braceDepth)
				state = 'code'
				i += 2
				continue
			}
			blank(i)
			i++
			continue
		}
		if (state === 'regex') {
			if (char === '\\') {
				blank(i)
				blank(i + 1)
				i += 2
				continue
			}
			if (char === '[') inRegexClass = true
			if (char === ']') inRegexClass = false
			if (char === '/' && !inRegexClass) {
				i++
				state = 'code'
				previousSignificant = '/'
				while (IDENTIFIER_CHAR.test(mask[i] ?? '')) {
					blank(i)
					i++
				}
				continue
			}
			blank(i)
			i++
			if (char === '\n') state = 'code'
			continue
		}
		if (char === '/' && next === '/') {
			blank(i)
			blank(i + 1)
			i += 2
			state = 'lineComment'
			continue
		}
		if (char === '/' && next === '*') {
			blank(i)
			blank(i + 1)
			i += 2
			state = 'blockComment'
			continue
		}
		if (char === "'" || char === '"') {
			i++
			state = char === "'" ? 'singleQuote' : 'doubleQuote'
			previousSignificant = char
			continue
		}
		if (char === '`') {
			i++
			state = 'template'
			previousSignificant = '`'
			continue
		}
		if (char === '/') {
			const endsOperand = previousSignificant !== '' && (IDENTIFIER_CHAR.test(previousSignificant) || REGEX_OPERAND_ENDERS.has(previousSignificant))
			if (!endsOperand) {
				i++
				state = 'regex'
				inRegexClass = false
				continue
			}
			previousSignificant = '/'
			i++
			continue
		}
		if (char === '{') {
			braceDepth++
			previousSignificant = '{'
			i++
			continue
		}
		if (char === '}') {
			if (braceDepth === templateInterpolations[templateInterpolations.length - 1]) {
				templateInterpolations.pop()
				blank(i)
				state = 'template'
			}
			braceDepth--
			previousSignificant = '}'
			i++
			continue
		}
		if (!WHITESPACE.test(char)) previousSignificant = char
		i++
	}
	return mask.join('')
}

// start sits on one of ( [ < {; the scan returns the index just past its partner, tracking every bracket kind so default values, nested generics, and destructuring cannot end the span early. A `>` preceded by `=` belongs to an arrow, not a generic.
function scanDelimited(mask: string, start: number): number | null {
	const open = mask[start]
	let parens = 0
	let brackets = 0
	let angles = 0
	let braces = 0
	let i = start
	while (i < mask.length) {
		const char = mask[i]
		if (char === '(') parens++
		else if (char === ')') {
			parens--
			if (open === '(' && parens === 0) return i + 1
		} else if (char === '[') brackets++
		else if (char === ']') {
			brackets--
			if (open === '[' && brackets === 0) return i + 1
		} else if (char === '<') angles++
		else if (char === '>' && mask[i - 1] !== '=') {
			if (angles > 0) angles--
			if (open === '<' && angles === 0) return i + 1
		} else if (char === '{') braces++
		else if (char === '}') {
			braces--
			if (open === '{' && braces === 0) return i + 1
		}
		i++
	}
	return null
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
}

// A dangling comma from a multi-line parameter list is dropped, matching how the compiler version joined parameters.
function normalizeParameters(sourceText: string, start: number, end: number): string {
	const text = normalizeWhitespace(sourceText.slice(start, end))
	if (text.endsWith(',')) return text.slice(0, -1)
	return text
}

// Newline-turned-spaces just inside angle brackets are padding from multi-line generic lists, not source tokens.
function normalizeTypeParameters(sourceText: string, start: number, end: number): string {
	return normalizeWhitespace(sourceText.slice(start, end)).replace(/< /g, '<').replace(/ >/g, '>')
}

interface ReturnTypeScan {
	text: string
	end: number
}

// A `{` at bracket depth zero in a return type is the body brace only when the type is complete. After `:`, `|`, or `&`, or after the word `is` (a type predicate), another type must follow, so the brace opens an object-literal type instead.
function isTypeLiteralBrace(mask: string, braceIndex: number): boolean {
	let j = braceIndex - 1
	while (j >= 0 && WHITESPACE.test(mask[j] ?? '')) j--
	const char = mask[j]
	if (char === ':' || char === '|' || char === '&') return true
	if (!isIdentifierChar(char)) return false
	let wordStart = j
	while (wordStart > 0 && isIdentifierChar(mask[wordStart - 1])) wordStart--
	return mask.slice(wordStart, j + 1) === 'is'
}

// Scans the type after `:` in a declaration; ends at the body brace, a semicolon, or a newline once type text has accumulated (overload signatures in this codebase end without semicolons), with `end` left on the terminator.
function scanFunctionReturnType(sourceText: string, mask: string, start: number): ReturnTypeScan {
	if (mask[start] !== ':') return { text: '', end: start }
	let i = skipWhitespace(mask, start + 1)
	const textStart = i
	let parens = 0
	let brackets = 0
	let angles = 0
	let braces = 0
	while (i < mask.length) {
		const char = mask[i]
		if (char === '(') parens++
		else if (char === ')' && parens > 0) parens--
		else if (char === '[') brackets++
		else if (char === ']' && brackets > 0) brackets--
		else if (char === '<') angles++
		else if (char === '>' && mask[i - 1] !== '=') {
			if (angles > 0) angles--
		} else if (char === '{') {
			if (parens === 0 && brackets === 0 && angles === 0 && braces === 0 && !isTypeLiteralBrace(mask, i)) break
			braces++
		} else if (char === '}') {
			if (braces === 0) break
			braces--
		} else if (parens === 0 && brackets === 0 && angles === 0 && braces === 0) {
			if (char === ';') break
			if (char === '\n' && sourceText.slice(textStart, i).trim() !== '') break
		}
		i++
	}
	const text = normalizeWhitespace(sourceText.slice(textStart, i))
	return { text: text === '' ? '' : `: ${text}`, end: i }
}

// Arrow return types end at the top-level `=>` rather than a body brace; `end` is left on the `=` so the caller can confirm the arrow follows.
function scanArrowReturnType(sourceText: string, mask: string, start: number): ReturnTypeScan {
	if (mask[start] !== ':') return { text: '', end: start }
	let i = skipWhitespace(mask, start + 1)
	const textStart = i
	let parens = 0
	let brackets = 0
	let angles = 0
	let braces = 0
	while (i < mask.length) {
		const char = mask[i]
		if (char === '(') parens++
		else if (char === ')' && parens > 0) parens--
		else if (char === '[') brackets++
		else if (char === ']' && brackets > 0) brackets--
		else if (char === '<') angles++
		else if (char === '>' && mask[i - 1] !== '=') {
			if (angles > 0) angles--
		} else if (char === '{') braces++
		else if (char === '}' && braces > 0) braces--
		else if (char === '=' && mask[i + 1] === '>' && parens === 0 && brackets === 0 && angles === 0 && braces === 0) {
			const text = normalizeWhitespace(sourceText.slice(textStart, i))
			return { text: text === '' ? '' : `: ${text}`, end: i }
		}
		i++
	}
	return { text: '', end: textStart }
}

// Skips a `: Type` annotation up to the `=` or `,` that follows it; a `=` that starts `=>` (a function type) is not a terminator.
function skipAnnotation(mask: string, start: number): number {
	let i = start
	let parens = 0
	let brackets = 0
	let angles = 0
	let braces = 0
	while (i < mask.length) {
		const char = mask[i]
		if (char === '(') parens++
		else if (char === ')' && parens > 0) parens--
		else if (char === '[') brackets++
		else if (char === ']' && brackets > 0) brackets--
		else if (char === '<') angles++
		else if (char === '>' && mask[i - 1] !== '=') {
			if (angles > 0) angles--
		} else if (char === '{') braces++
		else if (char === '}' && braces > 0) braces--
		else if (parens === 0 && brackets === 0 && angles === 0 && braces === 0) {
			if (char === ',' || char === ';' || char === '\n') return i
			if (char === '=' && mask[i + 1] !== '>') return i
		}
		i++
	}
	return i
}

// Skips a declarator's initializer expression up to the comma/semicolon/newline that ends the declarator, or a stray `}` belonging to an enclosing block. Newlines only terminate at bracket depth zero; an expression wrapped after a binary operator ends early, which is safe because the orphaned remainder contains no declaration-shaped text at line start.
function skipInitializer(mask: string, start: number): number {
	let i = start
	let parens = 0
	let brackets = 0
	let angles = 0
	let braces = 0
	while (i < mask.length) {
		const char = mask[i]
		if (char === '(') parens++
		else if (char === ')' && parens > 0) parens--
		else if (char === '[') brackets++
		else if (char === ']' && brackets > 0) brackets--
		else if (char === '<') angles++
		else if (char === '>' && mask[i - 1] !== '=') {
			if (angles > 0) angles--
		} else if (char === '{') braces++
		else if (char === '}') {
			if (braces === 0) return i
			braces--
		} else if (parens === 0 && brackets === 0 && angles === 0 && braces === 0) {
			if (char === ',' || char === ';' || char === '\n') return i
		}
		i++
	}
	return i
}

interface FunctionLikeInitializer {
	params: string
	returnType: string
	end: number
}

// start sits just after `=`. Recognizes arrow functions (parenthesized or single-identifier parameters, optional async and return type) and function expressions; any other initializer renders as a bare name, matching the compiler version.
function parseFunctionLikeInitializer(sourceText: string, mask: string, start: number): FunctionLikeInitializer | null {
	let i = skipWhitespace(mask, start)
	const first = isIdentifierStart(mask[i]) ? readWord(mask, i) : null
	if (first !== null && first.word === 'async') {
		const afterAsync = skipWhitespace(mask, first.end)
		if (mask[afterAsync] !== '(' && !isIdentifierStart(mask[afterAsync])) return null
		i = afterAsync
	}
	const word = isIdentifierStart(mask[i]) ? readWord(mask, i) : null
	if (word !== null && word.word === 'function') {
		let j = skipWhitespace(mask, word.end)
		if (mask[j] === '*') j = skipWhitespace(mask, j + 1)
		if (isIdentifierStart(mask[j])) j = skipWhitespace(mask, readWord(mask, j).end)
		if (mask[j] !== '(') return null
		const paramsEnd = scanDelimited(mask, j)
		if (paramsEnd === null) return null
		const params = normalizeParameters(sourceText, j + 1, paramsEnd - 1)
		const returnType = scanFunctionReturnType(sourceText, mask, paramsEnd)
		const body = skipWhitespace(mask, returnType.end)
		if (mask[body] !== '{') return null
		return { params, returnType: returnType.text, end: body }
	}
	if (mask[i] === '(') {
		const paramsEnd = scanDelimited(mask, i)
		if (paramsEnd === null) return null
		const params = normalizeParameters(sourceText, i + 1, paramsEnd - 1)
		let returnType = ''
		let j = skipWhitespace(mask, paramsEnd)
		if (mask[j] === ':') {
			const scanned = scanArrowReturnType(sourceText, mask, j)
			returnType = scanned.text
			j = scanned.end
		}
		if (mask[j] !== '=' || mask[j + 1] !== '>') return null
		return { params, returnType, end: j + 2 }
	}
	if (word !== null) {
		const afterName = skipWhitespace(mask, word.end)
		if (mask[afterName] === '=' && mask[afterName + 1] === '>') {
			return { params: word.word, returnType: '', end: afterName + 2 }
		}
	}
	return null
}

function parseVariable(sourceText: string, mask: string, start: number, prefix: string): ParseResult {
	const symbols: string[] = []
	let i = start
	while (i < mask.length) {
		i = skipWhitespace(mask, i)
		const char = mask[i]
		if (char === '{' || char === '[') {
			// Destructuring binds no single name, so it renders nothing — the compiler version's identifier-only rule.
			const patternEnd = scanDelimited(mask, i)
			if (patternEnd === null) break
			i = skipWhitespace(mask, patternEnd)
			if (mask[i] === ':') i = skipAnnotation(mask, skipWhitespace(mask, i + 1))
			i = skipWhitespace(mask, i)
			if (mask[i] === '=') i = skipInitializer(mask, i + 1)
		} else if (isIdentifierStart(char)) {
			const name = readWord(mask, i)
			i = skipWhitespace(mask, name.end)
			if (mask[i] === ':') i = skipAnnotation(mask, skipWhitespace(mask, i + 1))
			i = skipWhitespace(mask, i)
			if (mask[i] === '=') {
				const initializer = parseFunctionLikeInitializer(sourceText, mask, i + 1)
				if (initializer === null) {
					symbols.push(`${prefix}${name.word}`)
					i = skipInitializer(mask, i + 1)
				} else {
					symbols.push(`${prefix}${name.word}(${initializer.params})${initializer.returnType}`)
					i = skipInitializer(mask, initializer.end)
				}
			} else {
				symbols.push(`${prefix}${name.word}`)
			}
		} else {
			break
		}
		if (mask[i] === ',') {
			i++
			continue
		}
		if (mask[i] === ';') i++
		break
	}
	return { symbols, end: i }
}

function parseFunction(sourceText: string, mask: string, start: number, prefix: string): ParseResult | null {
	let i = skipWhitespace(mask, start)
	if (mask[i] === '*') i = skipWhitespace(mask, i + 1)
	let name = '(anonymous)'
	if (isIdentifierStart(mask[i])) {
		const word = readWord(mask, i)
		name = word.word
		i = skipWhitespace(mask, word.end)
	}
	let typeParameters = ''
	if (mask[i] === '<') {
		const typeEnd = scanDelimited(mask, i)
		if (typeEnd === null) return null
		typeParameters = normalizeTypeParameters(sourceText, i, typeEnd)
		i = skipWhitespace(mask, typeEnd)
	}
	if (mask[i] !== '(') return null
	const paramsEnd = scanDelimited(mask, i)
	if (paramsEnd === null) return null
	const params = normalizeParameters(sourceText, i + 1, paramsEnd - 1)
	const returnType = scanFunctionReturnType(sourceText, mask, paramsEnd)
	const end = skipWhitespace(mask, returnType.end)
	return { symbols: [`${prefix}${name}${typeParameters}(${params})${returnType.text}`], end }
}

// Skips a class member that renders no line (property, index signature) up to its terminating semicolon/newline or the class body's closing brace.
function skipMember(mask: string, start: number): number {
	let i = start
	let parens = 0
	let brackets = 0
	let angles = 0
	let braces = 0
	while (i < mask.length) {
		const char = mask[i]
		if (char === '(') parens++
		else if (char === ')' && parens > 0) parens--
		else if (char === '[') brackets++
		else if (char === ']' && brackets > 0) brackets--
		else if (char === '<') angles++
		else if (char === '>' && mask[i - 1] !== '=') {
			if (angles > 0) angles--
		} else if (char === '{') braces++
		else if (char === '}') {
			if (braces === 0 && parens === 0 && brackets === 0) return i
			if (braces > 0) braces--
		} else if (parens === 0 && brackets === 0 && angles === 0 && braces === 0) {
			if (char === ';' || char === '\n') return i
		}
		i++
	}
	return i
}

interface MemberResult {
	line: string | null
	end: number
}

function parseMember(sourceText: string, mask: string, start: number): MemberResult | null {
	let i = start
	let isAsync = false
	let isStatic = false
	while (isIdentifierStart(mask[i])) {
		const word = readWord(mask, i)
		if (word.word === 'async') isAsync = true
		else if (word.word === 'static') isStatic = true
		else if (!MEMBER_MODIFIERS.has(word.word)) break
		i = skipWhitespace(mask, word.end)
	}
	if (mask[i] === '*') i = skipWhitespace(mask, i + 1)
	let name = ''
	if (mask[i] === '#') {
		i++
		if (!isIdentifierStart(mask[i])) return null
		const word = readWord(mask, i)
		name = `#${word.word}`
		i = word.end
	} else if (isIdentifierStart(mask[i])) {
		const word = readWord(mask, i)
		name = word.word
		i = word.end
	} else {
		return null
	}
	const afterName = skipWhitespace(mask, i)
	if (name === 'constructor') {
		if (mask[afterName] !== '(') return { line: null, end: i }
		const paramsEnd = scanDelimited(mask, afterName)
		if (paramsEnd === null) return { line: null, end: i }
		const body = skipWhitespace(mask, paramsEnd)
		if (mask[body] !== '{') return { line: null, end: paramsEnd }
		return { line: null, end: scanDelimited(mask, body) ?? body }
	}
	// Accessors are not method declarations, so get/set are skipped like constructors; a `(` right after the word means a method literally named get or set.
	if ((name === 'get' || name === 'set') && mask[afterName] !== '(' && mask[afterName] !== '<') {
		let j = afterName
		if (mask[j] === '#') j++
		if (isIdentifierStart(mask[j])) j = skipWhitespace(mask, readWord(mask, j).end)
		if (mask[j] !== '(') return { line: null, end: skipMember(mask, i) }
		const paramsEnd = scanDelimited(mask, j)
		if (paramsEnd === null) return { line: null, end: i }
		const returnType = scanFunctionReturnType(sourceText, mask, paramsEnd)
		const body = skipWhitespace(mask, returnType.end)
		if (mask[body] !== '{') return { line: null, end: returnType.end }
		return { line: null, end: scanDelimited(mask, body) ?? body }
	}
	if (mask[afterName] !== '(' && mask[afterName] !== '<') return { line: null, end: skipMember(mask, i) }
	let j = afterName
	if (mask[j] === '<') {
		// Method type parameters position the parameter list but are not rendered, matching the compiler version.
		const typeEnd = scanDelimited(mask, j)
		if (typeEnd === null) return { line: null, end: i }
		j = skipWhitespace(mask, typeEnd)
	}
	if (mask[j] !== '(') return { line: null, end: skipMember(mask, i) }
	const paramsEnd = scanDelimited(mask, j)
	if (paramsEnd === null) return { line: null, end: i }
	const params = normalizeParameters(sourceText, j + 1, paramsEnd - 1)
	const returnType = scanFunctionReturnType(sourceText, mask, paramsEnd)
	const body = skipWhitespace(mask, returnType.end)
	let end = returnType.end
	if (mask[body] === '{') end = scanDelimited(mask, body) ?? body
	const prefix = (isAsync ? 'async ' : '') + (isStatic ? 'static ' : '')
	return { line: `\t${prefix}${name}(${params})${returnType.text}`, end }
}

function parseClassBody(sourceText: string, mask: string, start: number): { members: string[]; end: number } {
	const members: string[] = []
	let depth = 1
	let i = start
	while (i < mask.length) {
		const char = mask[i]
		if (char === '{') {
			depth++
			i++
			continue
		}
		if (char === '}') {
			depth--
			i++
			if (depth === 0) return { members, end: i }
			continue
		}
		if (depth !== 1 || (!isIdentifierStart(char) && char !== '#' && char !== '*')) {
			i++
			continue
		}
		if (isIdentifierStart(char) && mask[i - 1] === '.') {
			i = readWord(mask, i).end
			continue
		}
		const member = parseMember(sourceText, mask, i)
		if (member === null) {
			i++
			continue
		}
		if (member.line !== null) members.push(member.line)
		i = member.end
	}
	return { members, end: i }
}

function parseClass(sourceText: string, mask: string, start: number, prefix: string): ParseResult | null {
	let i = skipWhitespace(mask, start)
	let name = '(anonymous)'
	if (isIdentifierStart(mask[i])) {
		const word = readWord(mask, i)
		name = word.word
		i = word.end
	}
	i = skipWhitespace(mask, i)
	let typeParameters = ''
	if (mask[i] === '<') {
		const typeEnd = scanDelimited(mask, i)
		if (typeEnd === null) return null
		typeParameters = normalizeTypeParameters(sourceText, i, typeEnd)
		i = typeEnd
	}
	const header = `${prefix}class ${name}${typeParameters}`
	// The heritage clause (extends/implements) is skipped, not rendered; generics inside it may hold object literals, so angles gate the body brace.
	let parens = 0
	let brackets = 0
	let angles = 0
	while (i < mask.length) {
		const char = mask[i]
		if (char === '(') parens++
		else if (char === ')' && parens > 0) parens--
		else if (char === '[') brackets++
		else if (char === ']' && brackets > 0) brackets--
		else if (char === '<') angles++
		else if (char === '>' && mask[i - 1] !== '=') {
			if (angles > 0) angles--
		} else if (char === '{' && parens === 0 && brackets === 0 && angles === 0) break
		i++
	}
	if (mask[i] !== '{') return { symbols: [header], end: i }
	const body = parseClassBody(sourceText, mask, i + 1)
	return { symbols: [header, ...body.members], end: body.end }
}

function parseInterface(sourceText: string, mask: string, start: number, prefix: string): ParseResult | null {
	let i = skipWhitespace(mask, start)
	if (!isIdentifierStart(mask[i])) return null
	const word = readWord(mask, i)
	let j = skipWhitespace(mask, word.end)
	let typeParameters = ''
	if (mask[j] === '<') {
		const typeEnd = scanDelimited(mask, j)
		if (typeEnd === null) return null
		typeParameters = normalizeTypeParameters(sourceText, j, typeEnd)
		j = typeEnd
	}
	let angles = 0
	while (j < mask.length) {
		const char = mask[j]
		if (char === '<') angles++
		else if (char === '>' && mask[j - 1] !== '=') {
			if (angles > 0) angles--
		} else if (char === '{' && angles === 0) break
		j++
	}
	return { symbols: [`${prefix}interface ${word.word}${typeParameters}`], end: j }
}

function parseEnum(mask: string, start: number, prefix: string): ParseResult | null {
	let i = skipWhitespace(mask, start)
	if (!isIdentifierStart(mask[i])) return null
	const word = readWord(mask, i)
	let j = skipWhitespace(mask, word.end)
	while (j < mask.length && mask[j] !== '{') j++
	return { symbols: [`${prefix}enum ${word.word}`], end: j }
}

function parseTypeAlias(sourceText: string, mask: string, start: number, prefix: string): ParseResult | null {
	let i = skipWhitespace(mask, start)
	if (!isIdentifierStart(mask[i])) return null
	const word = readWord(mask, i)
	let j = skipWhitespace(mask, word.end)
	let typeParameters = ''
	if (mask[j] === '<') {
		const typeEnd = scanDelimited(mask, j)
		if (typeEnd === null) return null
		typeParameters = normalizeTypeParameters(sourceText, j, typeEnd)
		j = typeEnd
	}
	return { symbols: [`${prefix}type ${word.word}${typeParameters}`], end: j }
}

function parseDeclaration(sourceText: string, mask: string, start: number): ParseResult | null {
	let i = start
	let isExport = false
	let isAsync = false
	while (isIdentifierStart(mask[i])) {
		const word = readWord(mask, i)
		if (!DECLARATION_MODIFIERS.has(word.word)) break
		if (word.word === 'export') isExport = true
		if (word.word === 'async') isAsync = true
		i = skipWhitespace(mask, word.end)
	}
	if (!isIdentifierStart(mask[i])) return null
	const keyword = readWord(mask, i)
	const prefix = (isExport ? 'export ' : '') + (isAsync ? 'async ' : '')
	if (keyword.word === 'function') return parseFunction(sourceText, mask, keyword.end, prefix)
	if (keyword.word === 'class') return parseClass(sourceText, mask, keyword.end, prefix)
	if (keyword.word === 'interface') return parseInterface(sourceText, mask, keyword.end, prefix)
	if (keyword.word === 'enum') return parseEnum(mask, keyword.end, prefix)
	if (keyword.word === 'type') return parseTypeAlias(sourceText, mask, keyword.end, prefix)
	if (keyword.word === 'const' || keyword.word === 'let' || keyword.word === 'var') {
		const afterKeyword = skipWhitespace(mask, keyword.end)
		if (keyword.word === 'const' && isIdentifierStart(mask[afterKeyword]) && readWord(mask, afterKeyword).word === 'enum') {
			return parseEnum(mask, readWord(mask, afterKeyword).end, prefix)
		}
		return parseVariable(sourceText, mask, keyword.end, prefix)
	}
	return null
}

function extractSymbols(sourceText: string): string[] {
	const mask = maskSource(sourceText)
	const symbols: string[] = []
	let braceDepth = 0
	let parenDepth = 0
	let bracketDepth = 0
	let i = 0
	while (i < mask.length) {
		const char = mask[i]
		if (char === '{') {
			braceDepth++
			i++
			continue
		}
		if (char === '}') {
			if (braceDepth > 0) braceDepth--
			i++
			continue
		}
		if (char === '(') {
			parenDepth++
			i++
			continue
		}
		if (char === ')') {
			if (parenDepth > 0) parenDepth--
			i++
			continue
		}
		if (char === '[') {
			bracketDepth++
			i++
			continue
		}
		if (char === ']') {
			if (bracketDepth > 0) bracketDepth--
			i++
			continue
		}
		if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0 || !isIdentifierStart(char)) {
			i++
			continue
		}
		if (i > 0 && mask[i - 1] === '.') {
			i = readWord(mask, i).end
			continue
		}
		const word = readWord(mask, i)
		if (!DECLARATION_MODIFIERS.has(word.word) && !DECLARATION_KEYWORDS.has(word.word)) {
			i = word.end
			continue
		}
		const parsed = parseDeclaration(sourceText, mask, i)
		if (parsed === null) {
			i = word.end
			continue
		}
		symbols.push(...parsed.symbols)
		i = parsed.end
	}
	return symbols
}

function collectSourceFiles(rootDir: string): string[] {
	const results: string[] = []
	function walk(directory: string): void {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const fullPath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				walk(fullPath)
				continue
			}
			if (!entry.isFile()) continue
			if (!REPO_MAP_SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
			const relativePath = path.relative(rootDir, fullPath)
			if (isRepoMapExcludedPath(relativePath)) continue
			results.push(relativePath)
		}
	}
	walk(rootDir)
	return results.sort()
}

function main(): void {
	const rootDir = path.resolve(process.argv[2] ?? 'source')
	if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
		console.error(`not a directory: ${rootDir}`)
		process.exit(1)
	}
	for (const relativePath of collectSourceFiles(rootDir)) {
		const symbols = extractSymbols(fs.readFileSync(path.join(rootDir, relativePath), 'utf8'))
		if (symbols.length === 0) continue
		console.log(relativePath)
		for (const line of symbols) console.log(`\t${line}`)
	}
}

main()
