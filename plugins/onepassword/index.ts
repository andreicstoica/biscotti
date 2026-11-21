import { createClient, type Client, type Item, type ItemField } from "@1password/sdk";
import { declined, input, list, localTools, str, text, type LocalTool, type Plugin } from "@biscotti/core";
import { browser, fill, totp } from "../secure-fill/index.ts";

// Reads items from a vault-scoped 1Password Service Account and types values into a task VM's page over Chrome
// DevTools: no model ever sees the secrets.

const APPROVAL_MS = 15 * 60_000;
const FRAMED = ", in a frame from ";

const FIELD_ALIASES: Record<string, string[]> = {
  username: ["username", "email", "user"],
  password: ["password", "passcode", "pin"],
  totp: ["totp", "otp", "one-time password", "onetimepassword", "2fa"],
  number: ["ccnum", "number", "card number"],
  cvc: ["cvv", "cvc", "verification number", "security code"],
  expiry: ["expiry", "expiry date", "expiration date"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s-]+/g, " ");

export function findField(fields: ItemField[], wanted: string): ItemField | undefined {
  const key = norm(wanted);
  const candidates = new Set([key, ...(FIELD_ALIASES[key] ?? [])].map(norm));
  if (candidates.has("totp") || candidates.has("otp")) {
    const otp = fields.find((f) => f.fieldType === "Totp" || f.details?.type === "Otp");
    if (otp) return otp;
  }
  return fields.find((f) => candidates.has(norm(f.id)) || candidates.has(norm(f.title)));
}

export function fieldValue(field: ItemField): string {
  if (field.details?.type === "Otp" && field.details.content.code) return field.details.content.code;
  if (field.fieldType === "Totp") return totp(field.value);
  return field.value;
}

export function availableFieldNames(fields: ItemField[]): string[] {
  return fields
    .filter((f) => f.value || (f.details?.type === "Otp" && f.details.content.code))
    .map((f) => (f.fieldType === "Totp" ? "totp" : f.title || f.id));
}

export function resolveFields(item: Item, wanted: string[]): { values: () => string[] } | { missing: string[]; available: string[] } {
  const resolved: ItemField[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const field = findField(item.fields, name);
    if (!field || (!field.value && !(field.details?.type === "Otp" && field.details.content.code))) {
      missing.push(name);
    } else {
      resolved.push(field);
    }
  }
  if (missing.length) return { missing, available: availableFieldNames(item.fields) };
  return { values: () => resolved.map(fieldValue) };
}

export default {
  prompt: `1Password: use \`op_list\` to see which logins/cards are shared in 1Password, and start a task that calls
\`op_fill\` to type fields into the browser without seeing them.`,

  async tools(ctx) {
    const token = ctx.env("OP_SERVICE_ACCOUNT_TOKEN");
    if (!token) return localTools([]);

    const vaultFilter = ctx.env("OP_VAULT").trim();
    let clientPromise: Promise<Client> | undefined;
    const getClient = () =>
      (clientPromise ??= createClient({
        auth: token,
        integrationName: "biscotti",
        integrationVersion: "0.1.0",
      }));

    async function scopedVaults(client: Client) {
      const vaults = await client.vaults.list();
      if (!vaultFilter) return vaults;
      return vaults.filter((v) => v.title.toLowerCase() === vaultFilter.toLowerCase() || v.id === vaultFilter);
    }

    async function findItem(client: Client, title: string): Promise<Item | undefined> {
      const target = norm(title);
      for (const vault of await scopedVaults(client)) {
        const items = await client.items.list(vault.id);
        const match = items.find((i) => norm(i.title) === target);
        if (match) return client.items.get(vault.id, match.id);
      }
      return undefined;
    }

    const approvals = new Map<string, { sites: Set<string>; until: number }>();
    function approver(task: number | undefined, entry: string, question: (where: string) => string) {
      const key = task && `${task}\n${entry}`;
      return async (where: string) => {
        for (const [k, a] of approvals) if (a.until <= Date.now()) approvals.delete(k);
        const approval = key && approvals.get(key);
        if (approval && approval.sites.has(where)) return true;
        const covers = key ? ` A yes covers the rest of this task's fills of "${entry}" there, for ${APPROVAL_MS / 60_000} minutes.` : "";
        if (!(await ctx.ask(question(where) + covers))) return false;
        if (key) {
          const granted = approval || { sites: new Set<string>(), until: Date.now() + APPROVAL_MS };
          granted.sites.add(where).add(where.split(FRAMED)[0]);
          approvals.set(key, granted);
        }
        return true;
      };
    }

    const listTool: LocalTool = {
      name: "op_list",
      description: "List item titles and websites available in the 1Password vault shared with biscotti (never returns secret values).",
      input: input({}),
      async run() {
        const client = await getClient();
        const vaults = await scopedVaults(client);
        if (!vaults.length) return text(vaultFilter ? `No 1Password vault named "${vaultFilter}" is accessible.` : "No 1Password vaults are accessible.");
        const lines: string[] = [];
        for (const vault of vaults) {
          const items = await client.items.list(vault.id);
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
        const resolved = resolveFields(item, wanted);
        if ("missing" in resolved) {
          return text(`"${item.title}" has no ${resolved.missing.join(", ")}; available fields: ${resolved.available.join(", ")}.`);
        }
        const question = (where: string) =>
          `A task wants to type 1Password "${item.title}" (${wanted.join(", ")}) into ${where}, for ${String(why).slice(0, 200)}. Is ${where} the right site?`;
        return fill(browser(slot), resolved.values, approver(task, item.title, question))
          .then((into) => (into ? text(`Typed ${wanted.join(", ")} into: ${into.join(", ")}. Check the page before submitting.`) : declined))
          .catch((err: Error) => text(`Couldn't fill: ${err.message}`));
      },
    };

    return { ...localTools([listTool]), tasks: localTools([listTool, fillTool]) };
  },
} satisfies Plugin;
