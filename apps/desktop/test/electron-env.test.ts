import { expect, test } from "vitest";
import { electronEnv } from "../scripts/electron-env.ts";

test("drops ELECTRON_RUN_AS_NODE whatever its value, 0 included, and keeps everything else", () => {
  for (const value of ["1", "0", "false"]) {
    expect(
      electronEnv(
        { EXTRA: "x" },
        { env: { ELECTRON_RUN_AS_NODE: value, PATH: "/bin" }, platform: "darwin" },
      ),
    ).toEqual({ PATH: "/bin", EXTRA: "x" });
  }
  expect(electronEnv({ ELECTRON_RUN_AS_NODE: "1" }, { env: {}, platform: "darwin" })).toEqual({});
});

test("on Windows, whose names have no case, in any case; elsewhere only its own", () => {
  const env = { electron_run_as_node: "1", Path: "C:\\Windows" };
  expect(electronEnv({}, { env, platform: "win32" })).toEqual({ Path: "C:\\Windows" });
  expect(electronEnv({}, { env, platform: "darwin" })).toEqual(env);
});
