import { createClient, type Client, type Item } from "@1password/sdk";
import { input, list, localTools, str, text, type LocalTool, type Plugin } from "@biscotti/core";
import { createApprover, totp, typeIn } from "../secure-fill/index.ts";

// Reads items from a vault-scoped 1Password Service Account and types values into a task VM's page over Chrome
// DevTools: no model ever sees the secrets.

export type FieldLike = {
  id: string;
  title: string;
  fieldType: string;
  value: string;
  details?: { type: "Otp"; content: { code?: string } } | { type: string };
};

const ALIAS_GROUPS: string[][] = [
  ["username", "email", "user"],
  ["password", "passcode", "pin"],
  ["totp", "otp", "one time password", "onetimepassword", "2fa"],
  ["number", "ccnum", "card number"],
  ["cvc", "cvv", "verification number", "security code"],
  ["expiry", "expiry date", "expiration date"],
];

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s-]+/g, " ");

const ALIAS_MAP = new Map<string, Set<string>>();
for (const group of ALIAS_GROUPS) {
  const set = new Set(group);
  for (const alias of group) ALIAS_MAP.set(alias, set);
}

const isOtpField = (f: FieldLike) => f.fieldType === "Totp" || f.details?.type === "Otp";

const otpCode = (f: FieldLike) => (f.details?.type === "Otp" && "content" in f.details ? f.details.content.code : undefined);

export const hasValue = (f: FieldLike) => Boolean(f.value || otpCode(f));

export function findField(fields: readonly FieldLike[], wanted: string): FieldLike | undefined {
  const key = norm(wanted);
  const candidates = ALIAS_MAP.get(key) ?? new Set([key]);
  const exact = fields.find((f) => candidates.has(norm(f.id)) || candidates.has(norm(f.title)));
  if (exact) return exact;
  if (candidates.has("totp")) return fields.find(isOtpField);
  return undefined;
}

// Prefer fresh local TOTP computation at fill time (after owner approval) over the SDK's fetch-time code, which can
// expire if the owner takes >30s to approve.
export function fieldValue(field: FieldLike, now = Date.now()): string {
  if (isOtpField(field)) {
    if (field.value) return totp(field.value, now);
    const cached = otpCode(field);
    if (cached) return cached;
  }
  return field.value;
}

export function availableFieldNames(fields: readonly FieldLike[]): string[] {
  return fields.filter(hasValue).map((f) => (isOtpField(f) ? "totp" : f.title || f.id));
}

export function resolveFields(
  fields: readonly FieldLike[],
  wanted: readonly string[],
  now: () => number = Date.now,
): { values: () => string[] } | { missing: string[]; available: string[] } {
  const resolved: FieldLike[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const field = findField(fields, name);
    if (!field || !hasValue(field)) missing.push(name);
    else resolved.push(field);
  }
  if (missing.length) return { missing, available: availableFieldNames(fields) };
  return { values: () => resolved.map((f) => fieldValue(f, now())) };
}

export default {
  prompt: `1Password: use \`op_list\` to see which logins/cards are shared in 1Password, and start a task that calls
\`op_fill\` to type fields into the browser without seeing them.`,

  async tools(ctx) {
    // Optional plugin config: read process.env directly because ctx.env() throws when a variable is unset.
    const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim();
    if (!token) return localTools([]);

    const vaultFilter = process.env.OP_VAULT?.trim() ?? "";
    let clientPromise: Promise<Client> | undefined;
    const getClient = () =>
      (clientPromise ??= createClient({
        auth: token,
        integrationName: "biscotti",
        integrationVersion: "0.1.0",
      }).catch((err) => {
        clientPromise = undefined;
        throw err;
      }));

    async function scopedVaults(client: Client) {
      const vaults = await client.vaults.list();
      if (!vaultFilter) return vaults;
      return vaults.filter((v) => v.title.toLowerCase() === vaultFilter.toLowerCase() || v.id === vaultFilter);
    }

    async function findItem(client: Client, title: string): Promise<Item | undefined> {
      const target = norm(title);
      const vaults = await scopedVaults(client);
      const listed = await Promise.all(vaults.map(async (v) => ({ vault: v, items: await client.items.list(v.id) })));
      for (const { vault, items } of listed) {
        const match = items.find((i) => norm(i.title) === target);
        if (match) return client.items.get(vault.id, match.id);
      }
      return undefined;
    }

    const approver = createApprover(ctx.ask);

    const listTool: LocalTool = {
      name: "op_list",
      description: "List item titles and websites available in the 1Password vault shared with biscotti (never returns secret values).",
      input: input({}),
      async run() {
        const client = await getClient();
        const vaults = await scopedVaults(client);
        if (!vaults.length) return text(vaultFilter ? `No 1Password vault named "${vaultFilter}" is accessible.` : "No 1Password vaults are accessible.");
        const perVault = await Promise.all(vaults.map((v) => client.items.list(v.id)));
        const lines: string[] = [];
        for (const items of perVault) {
          for (const item of items) {
            const sites = item.websites.map((w) => w.url).filter(Boolean).join(", ");
            lines.push(`- ${item.title} (${item.category})${sites ? ` — ${sites}` : ""}`);
          }
        }
        return text(lines.length ? lines.join("\n") : "No items in the shared 1Password vault.");
      },
    };

    const fillTool: LocalTool = {
      name: "op_fill",
      description:
        "Type values from a 1Password item into the focused browser input without seeing them. Click the first input, then call this; multiple fields are typed in order with Tab between, e.g. ['username', 'password'] or ['totp']. Waits for the owner's approval.",
      input: input({
        name: str("The 1Password item title, from op_list."),
        fields: list(str()),
        why: str("What it's for, shown to the owner when asked, e.g. 'sign in to Amazon to check order status'."),
      }),
      async run({ name, fields, why }, { slot, task }) {
        const title = String(name);
        const wanted = fields as string[];
        const client = await getClient();
        const item = await findItem(client, title);
        if (!item) return text(`No 1Password item named "${title}".`);
        const resolved = resolveFields(item.fields, wanted);
        if ("missing" in resolved) {
          return text(`"${item.title}" has no ${resolved.missing.join(", ")}; available fields: ${resolved.available.join(", ")}.`);
        }
        const question = (where: string) =>
          `A task wants to type 1Password "${item.title}" (${wanted.join(", ")}) into ${where}, for ${String(why).slice(0, 200)}. Is ${where} the right site?`;
        return typeIn(slot, resolved.values, approver(task, item.title, question), (into) => `Typed ${wanted.join(", ")} into: ${into.join(", ")}. Check the page before submitting.`);
      },
    };

    return { ...localTools([listTool]), tasks: localTools([listTool, fillTool]) };
  },
} satisfies Plugin;
