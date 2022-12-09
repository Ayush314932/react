/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import invariant from "invariant";
import DisjointSet from "./DisjointSet";
import {
  HIRFunction,
  Identifier,
  Instruction,
  makeInstructionId,
  makeScopeId,
  Place,
  ReactiveScope,
  ScopeId,
} from "./HIR";
import { eachInstructionOperand } from "./visitors";

/**
 * For each mutable variable, infers a reactive scope which will construct that
 * variable. Variables that co-mutate are assigned to the same reactive scope.
 * This pass does *not* infer the set of instructions necessary to compute each
 * variable/scope, only the set of variables that will be computed by each scope.
 *
 * Examples:
 * ```javascript
 * // Mutable arguments
 * let x = {};
 * let y = [];
 * foo(x, y); // both args mutable, could alias each other
 * y.push(x); // y is part of callee, counts as operand
 *
 * let z = {};
 * y.push(z);
 *
 * // Mutable assignment
 * let x = {};
 * let y = [];
 * x.y = y; // trivial aliasing
 * ```
 *
 * More generally, all mutable operands (incl lvalue) of an instruction must go in the
 * same scope.
 *
 * ## Implementation
 *
 * 1. Iterate over all instructions in all blocks (order does not matter, single pass),
 *    and create disjoint sets ({@link DisjointSet}) for each set of operands that
 *    mutate together per above rules.
 * 2. Iterate the contents of each set, and assign a new {@link ScopeId} to each set,
 *    and update the `scope` property of each item in that set to that scope id.
 *
 * ## Other Issues Uncovered
 *
 * Mutable lifetimes need to account for aliasing (known todo, already described in InferMutableLifetimes.ts)
 *
 * ```javascript
 * let x = {};
 * let y = [];
 * x.y = y; // RHS is not considered mutable here bc not further mutation
 * mutate(x); // bc y is aliased here, it should still be considered mutable above
 * ```
 */
export function inferReactiveScopeVariables(fn: HIRFunction) {
  // Represents the set of reactive scopes as disjoint sets of identifiers
  // that mutate together.
  const scopeIdentifiers = new DisjointSet<Identifier>();
  for (const [_, block] of fn.body.blocks) {
    invariant(
      block.phis.size === 0,
      "Expected phis to be cleared by LeaveSSA pass"
    );

    for (const instr of block.instructions) {
      const operands: Array<Identifier> = [];
      if (instr.lvalue !== null) {
        // invariant(
        //   isMutable(instr, instr.lvalue!.place),
        //   "Assignment always means the value is mutable:\n" +
        //     printMixedHIR(instr)
        // );
        operands.push(instr.lvalue!.place.identifier);
      }
      for (const operand of eachInstructionOperand(instr)) {
        if (isMutable(instr, operand)) {
          operands.push(operand.identifier);
        }
      }
      if (operands.length !== 0) {
        scopeIdentifiers.union(operands);
      }
    }
  }

  // Maps each scope (by its identifying member) to a ScopeId value
  const scopes: Map<Identifier, ReactiveScope> = new Map();
  const scopeVariables: Map<ReactiveScope, Set<Identifier>> = new Map();

  /**
   * Iterate over all the identifiers and assign a unique ScopeId
   * for each scope (based on the set identifier).
   *
   * At the same time, group the identifiers in each scope and
   * build a MutableRange that describes the span of mutations
   * across all identifiers in each scope.
   */
  scopeIdentifiers.forEach((identifier, groupIdentifier) => {
    let scope = scopes.get(groupIdentifier);
    if (scope === undefined) {
      scope = {
        id: makeScopeId(scopes.size),
        range: identifier.mutableRange,
        dependencies: new Set(),
      };
      scopes.set(groupIdentifier, scope);
    } else {
      scope.range.start = makeInstructionId(
        Math.min(scope.range.start, identifier.mutableRange.start)
      );
      scope.range.end = makeInstructionId(
        Math.max(scope.range.end, identifier.mutableRange.end)
      );
    }
    identifier.scope = scope;

    let vars = scopeVariables.get(scope);
    if (vars === undefined) {
      vars = new Set();
      scopeVariables.set(scope, vars);
    }
    vars.add(identifier);
  });

  // Copy scope ranges to identifier ranges: not strictly required but this is useful
  // for visualization
  for (const [scope, vars] of scopeVariables) {
    for (const identifier of vars) {
      identifier.mutableRange.start = scope.range.start;
      identifier.mutableRange.end = scope.range.end;
    }
  }
}

// Is the operand mutable at this given instruction
function isMutable(instr: Instruction, place: Place): boolean {
  return (
    instr.id >= place.identifier.mutableRange.start &&
    instr.id < place.identifier.mutableRange.end
  );
}
