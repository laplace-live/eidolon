// toStartWith, toEndWith and toBeNumber, on Vitest's expect (a setup file, vitest.config.ts).
import { expect } from "vitest";

declare module "vitest" {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toStartWith(expected: string): R;
    toEndWith(expected: string): R;
    toBeNumber(): R;
  }
}

expect.extend({
  toStartWith(received: unknown, expected: string) {
    const pass = typeof received === "string" && received.startsWith(expected);
    return {
      pass,
      message: () =>
        `expected ${this.utils.printReceived(received)} ${pass ? "not " : ""}to start with ` +
        this.utils.printExpected(expected),
    };
  },
  toEndWith(received: unknown, expected: string) {
    const pass = typeof received === "string" && received.endsWith(expected);
    return {
      pass,
      message: () =>
        `expected ${this.utils.printReceived(received)} ${pass ? "not " : ""}to end with ` +
        this.utils.printExpected(expected),
    };
  },
  toBeNumber(received: unknown) {
    const pass = typeof received === "number";
    return {
      pass,
      message: () =>
        `expected ${this.utils.printReceived(received)} ${pass ? "not " : ""}to be a number`,
    };
  },
});
