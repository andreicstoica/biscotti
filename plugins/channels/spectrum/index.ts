import { input, localTools, optional, str, text, type Channel, type Plugin } from "@biscotti/core";
import { attachment, Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

// iMessage through Photon's Spectrum. Only the owner's one-on-one texts come through, never their group chats.

type Reactable = { react(emoji: string): Promise<unknown> };

const cleanVcardValue = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function vcard({ name, phone, note }: { name: string; phone?: string; note?: string }) {
  const fn = cleanVcardValue(name) || "Biscotti";
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:;${fn};;;`, `FN:${fn}`];
  if (phone && cleanVcardValue(phone)) lines.push(`TEL;TYPE=CELL;TYPE=VOICE;TYPE=pref:${cleanVcardValue(phone)}`);
  if (note && cleanVcardValue(note)) lines.push(`NOTE:${cleanVcardValue(note)}`);
  lines.push("END:VCARD", "");
  return lines.join("\r\n");
}

// A link on its own line goes as its own message, so it expands into a preview.
export function asTexts(reply: string) {
  const lines = reply.split("\n");
  const isLink = (line: string) => /^https?:\/\/\S+$/.test(line.trim());
  const body = lines.filter((l) => !isLink(l)).join("\n").trim();
  return [...(body ? [body] : []), ...lines.filter(isLink).map((l) => l.trim())];
}

// Tapbacks on the owner's latest text, plus sending a native iMessage contact card (.vcf).
export function spectrumTools() {
  let latest: Reactable | undefined;
  let sendAttachment: ((buf: Buffer, mimeType: string, name: string) => Promise<void>) | undefined;
  let defaultPhone = "";
  return {
    seen: (message: Reactable | undefined) => void (latest = message),
    bind: (send: typeof sendAttachment, phone: string) => {
      sendAttachment = send;
      defaultPhone = phone;
    },
    tools: localTools([
      {
        name: "react",
        description: "Tapback the user's latest message (❤️ 👍 👎 😂 ‼️ ❓), e.g. 👍 when starting on something, ❤️ on thanks. Can replace a reply.",
        input: input({ emoji: str() }),
        async run({ emoji }) {
          if (!latest) return text("No recent message to react to.");
          await latest.react(String(emoji));
          return text("Reacted.");
        },
      },
      {
        name: "send_contact_card",
        description: "Send a native iMessage contact card (.vcf attachment) so the owner can add biscotti (or a contact) to Contacts in one tap.",
        input: input({
          name: optional(str("Display name on the card. Defaults to 'Biscotti'.")),
          phone: optional(str("Phone number in E.164 format, e.g. +17739123997. Defaults to SPECTRUM_PHONE if configured.")),
          note: optional(str("Short note on the card.")),
        }),
        async run({ name, phone, note }) {
          if (!sendAttachment) return text("iMessage channel is not connected yet.");
          const fn = String(name ?? "Biscotti").trim() || "Biscotti";
          const tel = String(phone ?? defaultPhone).trim();
          const card = vcard({ name: fn, phone: tel || undefined, note: note ? String(note) : "Personal assistant" });
          const filename = `${fn.replace(/[^a-zA-Z0-9._-]+/g, "_") || "Biscotti"}.vcf`;
          await sendAttachment(Buffer.from(card, "utf8"), "text/vcard", filename);
          return text(`Sent contact card ${filename}${tel ? ` (${tel})` : ""}.`);
        },
      },
    ]),
  };
}

export async function connect(
  env: (name: string) => string,
  hooks: { seen?: (message: Reactable | undefined) => void; bind?: (send: ((buf: Buffer, mimeType: string, name: string) => Promise<void>) | undefined, phone: string) => void } = {},
): Promise<Channel & { close(): Promise<void> }> {
  const app = await Spectrum({
    projectId: env("SPECTRUM_PROJECT_ID"),
    projectSecret: env("SPECTRUM_PROJECT_SECRET"),
    providers: [imessage.config()],
  });
  const im = imessage(app);
  const owner = env("OWNER");
  const space = await im.space.create(await im.user(owner));
  hooks.bind?.(
    async (buf, mimeType, name) => void (await space.send(attachment(buf, { mimeType, name }))),
    process.env.SPECTRUM_PHONE?.trim() ?? "",
  );

  async function* messages() {
    for await (const [chat, message] of app.messages) {
      if (message.direction === "outbound" || message.content.type !== "text") continue;
      const group = (chat as { type?: string }).type === "group" || chat.id.includes(";+;");
      if (message.sender?.id !== owner || group) {
        console.warn(`ignoring message from ${message.sender?.id}${group ? " in a group chat" : ""}`);
        continue;
      }
      hooks.seen?.(message);
      yield { text: message.content.text };
    }
  }

  // Close the connection on shutdown: Photon keeps delivering to a dropped one for a while, so the next one hears nothing.
  const close = () => {
    hooks.seen?.(undefined);
    hooks.bind?.(undefined, "");
    return app.stop();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void close().finally(() => process.exit(0)));

  return {
    close,
    messages: messages(),
    async send(m) {
      if ("image" in m) return void (await space.send(attachment(m.image, { mimeType: "image/png", name: "screen.png" })));
      for (const t of asTexts(m.text)) await space.send(t);
    },
  };
}

const channelTools = spectrumTools();
export default {
  prompt: "A tapback (`react`) is a fine acknowledgment or answer on its own. Use `send_contact_card` when the owner asks for your contact card (.vcf).",
  channel: (ctx) => connect(ctx.env, channelTools),
  tools: async () => channelTools.tools,
} satisfies Plugin;
