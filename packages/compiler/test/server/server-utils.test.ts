import { deepStrictEqual, ok, strictEqual } from "assert";
import { Comment } from "../../core/index.js";
import { parse } from "../../core/parser.js";
import { TypeSpecScriptNode } from "../../core/types.js";
import { getCommentAtPosition, getPositionBeforeTrivia } from "../../server/server-utils.js";
import { extractCursor } from "../../testing/test-server-host.js";
import { dumpAST } from "../parser.test.js";

describe("compiler: server: utils", () => {
  describe("getCommentAtPosition", () => {
    function getCommentAtCursor(sourceWithCursor: string): {
      root: TypeSpecScriptNode;
      comment: Comment | undefined;
    } {
      const { source, pos } = extractCursor(sourceWithCursor);
      const root = parse(source, { comments: true });
      dumpAST(root);
      return { comment: getCommentAtPosition(root, pos), root };
    }

    it("finds one of multiple comments", () => {
      const { root, comment } = getCommentAtCursor(`
        /* First comment */
        // Second comment 
        /**
         * Third comment ┆
         */
      `);
      ok(comment);
      deepStrictEqual(comment, root.comments[2]);
    });

    it("does not find outside comment", () => {
      const { comment } = getCommentAtCursor(`
        /* First comment */
        ┆
        /* Second comment */
        /* Third comment */
      `);
      ok(!comment);
    });

    it("handles adjacent comments", () => {
      // Since the start position is included and end position is not, the
      // right of cursor should be returned.
      const { root, comment } = getCommentAtCursor(`
        /* First comment */┆/*Second comment */
      `);
      ok(comment);
      deepStrictEqual(comment, root.comments[1]);
    });
  });

  describe("getPositionBeforeTrivia", () => {
    function getPositionBeforeTriviaAtCursor(sourceWithCursor: string): {
      pos: number;
      root: TypeSpecScriptNode;
    } {
      const { source, pos } = extractCursor(sourceWithCursor);
      const root = parse(source, { comments: true });
      dumpAST(root);
      return { pos: getPositionBeforeTrivia(root, pos), root };
    }

    const testSourceWithoutTrailingTrivia = `model Test {}`;

    it("returns position unchanged with no trivia", () => {
      const { pos } = getPositionBeforeTriviaAtCursor(`${testSourceWithoutTrailingTrivia}┆`);
      strictEqual(pos, testSourceWithoutTrailingTrivia.length);
    });

    it("returns correct position before whitespace", () => {
      const { pos } = getPositionBeforeTriviaAtCursor(`${testSourceWithoutTrailingTrivia} ┆`);
      strictEqual(pos, testSourceWithoutTrailingTrivia.length);
    });

    it("returns correct position before trivia with cursor exactly at the end of comment", () => {
      const { pos } = getPositionBeforeTriviaAtCursor(`model Test {} /* Test */┆`);
      strictEqual(pos, testSourceWithoutTrailingTrivia.length);
    });

    it("returns correct position before lots of trivia with cursor in the middle of comment", () => {
      const { pos } = getPositionBeforeTriviaAtCursor(
        `model Test {} /* Test */ 
        // More

        /*
        More
        */

        /** 
         * Inside the last comment ┆ over here
         */`
      );
      strictEqual(pos, testSourceWithoutTrailingTrivia.length);
    });
  });
});
