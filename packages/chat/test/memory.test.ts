import { describe, expect, test } from "bun:test";
import { runChatStoreContract } from "../src/contract.ts";
import { MemoryChatStore } from "../src/index.ts";

runChatStoreContract({ describe, test, expect }, () => new MemoryChatStore());
