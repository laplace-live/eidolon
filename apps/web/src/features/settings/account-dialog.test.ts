// AccountDialog client-side validation for required API Base URLs on custom endpoints.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AccountView } from "@/lib/api";
import { type MountedRoot, mountFakeDom } from "@/test/fake-dom";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);

const mockCall = vi.fn();
vi.doMock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, call: mockCall };
});

const toastSuccess = vi.fn();
vi.doMock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

vi.doMock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
    open ? createElement("div", { "data-slot": "dialog" }, children) : null,
  DialogContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogDescription: ({ children }: { readonly children?: ReactNode }) =>
    createElement("p", null, children),
  DialogFooter: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogHeader: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogTitle: ({ children }: { readonly children?: ReactNode }) =>
    createElement("h2", null, children),
}));

vi.doMock("@/components/ui/command", () => ({
  Command: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  CommandEmpty: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  CommandGroup: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  CommandInput: () => createElement("input"),
  CommandItem: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  CommandList: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
}));

vi.doMock("@/components/ui/select", () => ({
  Select: ({ children }: { readonly children?: ReactNode }) => createElement("div", null, children),
  SelectContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  SelectItem: ({ children, value }: { readonly children?: ReactNode; readonly value: string }) =>
    createElement("div", { "data-select-value": value }, children),
  SelectTrigger: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  SelectValue: () => null,
}));

let baseChangeHandler: ((event: { target: { value: string } }) => void) | undefined;
vi.doMock("@/components/ui/input", () => ({
  Input: (props: {
    readonly id?: string;
    readonly type?: string;
    readonly value?: string;
    readonly placeholder?: string;
    readonly "aria-invalid"?: boolean;
    readonly onChange?: (event: { target: { value: string } }) => void;
  }) => {
    if (props.type === "url") baseChangeHandler = props.onChange;
    return createElement("input", {
      id: props.id,
      type: props.type,
      "data-value": props.value ?? "",
      placeholder: props.placeholder,
      "aria-invalid": props["aria-invalid"] ? "true" : undefined,
    });
  },
}));

const { AccountDialog } = await import("./account-dialog");

function findFormOnSubmit(root: unknown): ((event: { preventDefault(): void }) => void) | null {
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift() as
      | {
          readonly tagName?: string;
          readonly childNodes?: unknown[];
          readonly [k: string]: unknown;
        }
      | undefined;
    if (!node) continue;
    if (node.tagName === "FORM") {
      const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
      const onSubmit = propsKey
        ? (node[propsKey] as { readonly onSubmit?: (event: { preventDefault(): void }) => void })
            ?.onSubmit
        : undefined;
      if (onSubmit) return onSubmit;
    }
    if (Array.isArray(node.childNodes)) queue.push(...node.childNodes);
  }
  return null;
}

function compatibleAccount(baseUrl: AccountView["baseUrl"]): AccountView {
  return {
    id: "openai-compatible",
    provider: "openai-compatible",
    name: "OpenAI-compatible Server",
    isDefault: true,
    saved: true,
    key: { value: null, source: null },
    baseUrl,
    options: {},
    uses: [],
    needed: true,
  };
}

describe("AccountDialog required API Base validation", () => {
  let mounted: MountedRoot | null = null;

  afterEach(async () => {
    baseChangeHandler = undefined;
    mockCall.mockReset();
    toastSuccess.mockReset();
    if (mounted !== null) {
      const current = mounted;
      mounted = null;
      await current.unmount();
    }
  });

  test("refuses saving an emptied required API Base without an inherited base and submits once filled", async () => {
    const client = new QueryClient();
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const onClose = vi.fn();
    const account = compatibleAccount({ value: "http://127.0.0.1:8000/v1", source: "account" });

    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(AccountDialog, { open: true, account, onClose }),
        ),
      ),
    );

    expect(baseChangeHandler).toBeDefined();
    await mounted.act(() => {
      baseChangeHandler!({ target: { value: "   " } });
    });

    const submitEmpty = findFormOnSubmit(mounted.container);
    expect(submitEmpty).not.toBeNull();
    await mounted.act(() => {
      submitEmpty!({ preventDefault() {} });
    });

    expect(mockCall).not.toHaveBeenCalled();
    expect(mounted.container.innerHTML).toContain("Required.");
    expect(mounted.container.innerHTML).toContain('aria-invalid="true"');

    await mounted.act(() => {
      baseChangeHandler!({ target: { value: " http://127.0.0.1:9000/v1 " } });
    });
    expect(mounted.container.innerHTML).not.toContain("Required.");
    expect(mounted.container.innerHTML).not.toContain('aria-invalid="true"');

    mockCall.mockResolvedValueOnce({
      ...account,
      baseUrl: { value: "http://127.0.0.1:9000/v1", source: "account" },
    });
    const submitValid = findFormOnSubmit(mounted.container);
    await mounted.act(async () => {
      submitValid!({ preventDefault() {} });
    });

    expect(mockCall).toHaveBeenCalledWith("PUT /api/local/accounts/:id", {
      params: { id: "openai-compatible" },
      body: { name: "OpenAI-compatible Server", baseUrl: "http://127.0.0.1:9000/v1" },
    });
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("allows saving without a typed base when the provider inherits one from the environment", async () => {
    const client = new QueryClient();
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const onClose = vi.fn();
    const account = compatibleAccount({ value: "http://127.0.0.1:8000/v1", source: "env" });

    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(AccountDialog, { open: true, account, onClose }),
        ),
      ),
    );

    mockCall.mockResolvedValueOnce(account);
    const submit = findFormOnSubmit(mounted.container);
    expect(submit).not.toBeNull();
    await mounted.act(async () => {
      submit!({ preventDefault() {} });
    });

    expect(mounted.container.innerHTML).not.toContain("Required.");
    expect(mockCall).toHaveBeenCalledWith("PUT /api/local/accounts/:id", {
      params: { id: "openai-compatible" },
      body: { name: "OpenAI-compatible Server" },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
