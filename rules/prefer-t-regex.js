'use strict';

const {visitIf} = require('enhance-visitors');
const createAvaRule = require('../create-ava-rule');
const util = require('../util');

const create = context => {
	const ava = createAvaRule();

	const booleanTests = new Set([
		'true',
		'false',
		'truthy',
		'falsy',
	]);

	const equalityTests = new Set([
		'is',
		'deepEqual',
	]);

	// Find the latest reference to the given identifier's name.
	const findReference = node => {
		const {sourceCode} = context;
		const reference = sourceCode.getScope(node).references.find(reference => reference.identifier.name === node.name);

		if (reference?.resolved) {
			const definitions = reference.resolved.defs;

			if (definitions.length === 0) {
				return;
			}

			return definitions.at(-1).node;
		}
	};

	/*
	Recursively find the "origin" node of the given node.

	Note: `sourceCode.getScope()` doesn't contain information about the outer scope so in most cases this function will only find the reference directly above the current scope. So the following code will only find the reference in this order: y -> x, and it will have no knowledge of the number `0`. (assuming we run this function on the identifier `y`)

	```
	const test = require('ava');

	let x = 0;
	let y = x;

	test(t => {
		t.is(y, 0);
	});
	```
	*/
	const findRootReference = node => {
		if (!node) {
			return;
		}

		if (node.type === 'Identifier') {
			const reference = findReference(node);

			if (reference?.init) {
				return findRootReference(reference.init);
			}

			return node;
		}

		if (node.type === 'CallExpression' || node.type === 'NewExpression') {
			return findRootReference(node.callee);
		}

		if (node.type === 'MemberExpression') {
			return findRootReference(node.object);
		}

		return node;
	};

	/*
	Determine if the given node is a regex expression.

	There are two ways to create regex expressions in JavaScript: Regex literal and `RegExp` class.
	1. Regex literal can be easily looked up using the `.regex` property on the node.
	2. `RegExp` class can't be looked up so the function just checks for the name `RegExp`.
	*/
	const isRegExp = lookup => {
		if (!lookup) {
			return false;
		}

		if (lookup.regex) {
			return true;
		}

		// Look up references in case it's a variable or RegExp declaration.
		const reference = findRootReference(lookup);

		if (!reference) {
			return false;
		}

		return reference.regex ?? reference.name === 'RegExp';
	};

	const booleanHandler = node => {
		const firstArgument = node.arguments[0];

		if (!firstArgument) {
			return;
		}

		const isFunctionCall = firstArgument.type === 'CallExpression';
		if (!isFunctionCall || !firstArgument.callee.property) {
			return;
		}

		const {name} = firstArgument.callee.property;
		let lookup = {};
		let variable = {};

		if (name === 'test') {
			// Represent: `lookup.test(variable)`
			lookup = firstArgument.callee.object;
			variable = firstArgument.arguments[0];
		} else if (['search', 'match'].includes(name)) {
			// Represent: `variable.match(lookup)`
			lookup = firstArgument.arguments[0];
			variable = firstArgument.callee.object;
		}

		if (!isRegExp(lookup)) {
			return;
		}

		const assertion = ['true', 'truthy'].includes(node.callee.property.name) ? 'regex' : 'notRegex';

		const fix = fixer => {
			const source = context.getSourceCode();
			return [
				fixer.replaceText(node.callee.property, assertion),
				fixer.replaceText(firstArgument, `${source.getText(variable)}, ${source.getText(lookup)}`),
			];
		};

		context.report({
			node,
			message: `Prefer using the \`t.${assertion}()\` assertion.`,
			fix,
		});
	};

	const equalityHandler = node => {
		const [firstArgument, secondArgument] = node.arguments;

		const firstArgumentIsRegex = isRegExp(firstArgument);
		const secondArgumentIsRegex = isRegExp(secondArgument);

		// If both are regex, or neither are, the expression is ok.
		if (firstArgumentIsRegex === secondArgumentIsRegex) {
			return;
		}

		const matchee = secondArgumentIsRegex ? firstArgument : secondArgument;

		if (!matchee) {
			return;
		}

		const regex = secondArgumentIsRegex ? secondArgument : firstArgument;

		const booleanFixer = assertion => fixer => {
			const source = context.getSourceCode();
			return [
				fixer.replaceText(node.callee.property, assertion),
				fixer.replaceText(firstArgument, `${source.getText(regex.arguments[0])}`),
				fixer.replaceText(secondArgument, `${source.getText(regex.callee.object)}`),
			];
		};

		// Only fix a statically verifiable equality.
		if (regex && matchee.type === 'Literal') {
			let assertion;

			if (matchee.raw === 'true') {
				assertion = 'regex';
			} else if (matchee.raw === 'false') {
				assertion = 'notRegex';
			} else {
				return;
			}

			context.report({
				node,
				message: `Prefer using the \`t.${assertion}()\` assertion.`,
				fix: booleanFixer(assertion),
			});
		}
	};

	return ava.merge({
		CallExpression: visitIf([
			ava.isInTestFile,
			ava.isInTestNode,
		],
		)(node => {
			if (!node?.callee?.property) {
				return;
			}

			const isAssertion = node.callee.type === 'MemberExpression'
				&& util.getNameOfRootNodeObject(node.callee) === 't';

			const isBooleanAssertion = isAssertion
				&& booleanTests.has(node.callee.property.name);

			const isEqualityAssertion = isAssertion
				&& equalityTests.has(node.callee.property.name);

			if (isBooleanAssertion) {
				booleanHandler(node);
			} else if (isEqualityAssertion) {
				equalityHandler(node);
			}
		}),
	});
};

module.exports = {
	create,
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Prefer using `t.regex()` to test regular expressions.',
			url: util.getDocsUrl(__filename),
		},
		fixable: 'code',
		schema: [],
	},
};
