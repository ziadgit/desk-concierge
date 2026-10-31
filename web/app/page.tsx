"use client";

import { CopilotKit, useCopilotAction, useCopilotChat, useCopilotReadable } from "@copilotkit/react-core";
import { CopilotChat, type UserMessageProps } from "@copilotkit/react-ui";
import { Role, TextMessage } from "@copilotkit/runtime-client-gql";
import { useCallback, useEffect, useRef, useState } from "react";
import { audioUnlocked, emojify, isBoop, playBoop, unlockAudio } from "@/lib/fun";

// One CopilotKit chat holds everything: the owner talking to the agent,
// the agent's answers, and the Cardputer traffic. Device messages are
// appended to the chat as user-side messages with a tagged first line,
// so the agent reads them as context (and gets the session id it needs
// to reply), and DeviceAwareUserMessage renders them as device bubbles.
//
//   📟 [visitor|s=<session>] boop :)
//   📟 [concierge|s=<session>|urgent] Hi! Ziad is at judging...
//   📟 [owner|s=<session>] Back in 5!
//   📟 [event|s=<session>] Someone picked up the device
const TAG = /^📟 \[(visitor|concierge|owner|event)\|s=([^|\]]+)(\|urgent)?\] ([\s\S]*)$/;

type Sender = "visitor" | "concierge" | "owner" | "event";
type FeedMsg = {
  id: number;
  ts: number;
  session: string;
  sender: "visitor" | "claude" | "owner" | "event";
  text: string;
  urgent: number;
};
type Settings = { status: string; context: string };

async function api<T>(path: string, body?: unknown): Promise<T> {
  // Same-origin fetches reuse the browser's cached basic-auth credentials.
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function tagLine(m: FeedMsg) {
  const sender: Sender = m.sender === "claude" ? "concierge" : m.sender;
  // Events lead with their time, to the second, so the feed reads like a
  // log and the agent can answer "when did someone grab it?".
  const text = m.sender === "event" ? `${fmtTime(m.ts)} · ${m.text}` : m.text;
  return `📟 [${sender}|s=${m.session}${m.urgent ? "|urgent" : ""}] ${text}`;
}

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Short, stable visitor label from the session id so interleaved visitors
// are easy to tell apart.
function visitorLabel(session: string) {
  return `Visitor ${session.slice(0, 4)}`;
}

function messageText(message: UserMessageProps["message"]): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
  }
  return "";
}

function DeviceAwareUserMessage({ message }: UserMessageProps) {
  const text = messageText(message);
  const match = text.match(TAG);
  if (!match) {
    return (
      <div className="bubble you">
        <div className="who">You</div>
        <div>{text}</div>
      </div>
    );
  }
  const [, sender, session, urgent, body] = match;
  if (sender === "event") {
    return <div className="event">📟 {body}</div>;
  }
  const label = visitorLabel(session);
  const who =
    sender === "visitor" ? `📟 ${label}` :
    sender === "concierge" ? `Concierge → ${label}` :
    `You → ${label}`;
  const boop = sender === "visitor" && isBoop(body);
  return (
    <div className={`bubble device ${sender}${boop ? " boop" : ""}`}>
      <div className="who">
        {who}
        {urgent && <span className="badge">URGENT</span>}
      </div>
      <div>{emojify(body)}</div>
    </div>
  );
}

// Polls the device feed and streams it into the CopilotKit chat.
function useDeviceFeed(onLive: (live: boolean) => void) {
  const { appendMessage } = useCopilotChat();
  const lastId = useRef(0);
  const busy = useRef(false);

  useEffect(() => {
    const poll = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const { messages } = await api<{ messages: FeedMsg[] }>(`/api/owner/feed?after=${lastId.current}`);
        onLive(true);
        const firstLoad = lastId.current === 0;
        for (const m of messages) {
          lastId.current = Math.max(lastId.current, m.id);
          // Urgent arrivals wake the agent so it can flag them and offer a
          // reply; everything else just lands in the feed as context.
          const followUp = !firstLoad && m.urgent === 1;
          await appendMessage(new TextMessage({ role: Role.User, content: tagLine(m) }), { followUp });
          if (firstLoad) continue;
          if (m.sender === "visitor" && isBoop(m.text)) playBoop();
          if (m.urgent) {
            document.title = "(!) Desk Inbox";
            if ("Notification" in window && Notification.permission === "granted") {
              new Notification("Someone's at your desk", { body: m.text });
            }
          }
        }
      } catch {
        onLive(false);
      } finally {
        busy.current = false;
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [appendMessage, onLive]);
}

function Inbox() {
  const [settings, setSettings] = useState<Settings>({ status: "", context: "" });
  const [live, setLive] = useState(true);
  const [soundOn, setSoundOn] = useState(false);

  useDeviceFeed(useCallback((l: boolean) => setLive(l), []));

  useEffect(() => {
    api<Settings>("/api/owner/settings").then(setSettings).catch(() => {});
    const onFocus = () => { document.title = "Desk Inbox"; };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useCopilotReadable({
    description: "The owner's status and the extra info the desk concierge tells visitors.",
    value: settings,
  });

  useCopilotAction({
    name: "replyToVisitor",
    description:
      "Send a message from the owner to a visitor at the desk. It shows on the Cardputer's " +
      "screen. Use the s= session id from that visitor's 📟 lines.",
    parameters: [
      { name: "sessionId", type: "string", description: "The visitor's session id", required: true },
      {
        name: "text",
        type: "string",
        description: "The message. Plain ASCII, under 200 characters; the device can't draw emoji.",
        required: true,
      },
    ],
    handler: async ({ sessionId, text }) => {
      await api("/api/owner/reply", { session: sessionId, text });
      return `Sent to ${visitorLabel(sessionId)}`;
    },
  });

  useCopilotAction({
    name: "setStatus",
    description:
      "Update what the desk concierge tells visitors. Only pass `context` when the owner " +
      "asked to change that extra info.",
    parameters: [
      { name: "status", type: "string", description: "Short status, e.g. 'At judging until 4pm'", required: true },
      { name: "context", type: "string", description: "Extra info for visitors", required: false },
    ],
    handler: async ({ status, context }) => {
      const next = { status, context: context ?? settings.context };
      await api("/api/owner/settings", next);
      setSettings(next);
      return "Status updated";
    },
  });

  useCopilotAction({
    name: "boop",
    description: "Play the boop sound in the inbox, when the owner asks to hear it.",
    parameters: [],
    handler: async () => {
      playBoop();
      return audioUnlocked() ? "Booped" : "Sound is off; the owner needs to click 'Enable sound' first";
    },
  });

  const enableSound = () => {
    unlockAudio();
    setSoundOn(true);
    playBoop();
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };

  return (
    <div className="app">
      <header>
        <h1>Desk Inbox</h1>
        <span className={live ? "live" : "live down"}>{live ? "live" : "reconnecting…"}</span>
        <span className="status" title="Ask the agent to change it">
          {settings.status ? `Status: ${settings.status}` : "No status set"}
        </span>
        <span className="spacer" />
        {soundOn ? (
          <button className="ghost" onClick={playBoop}>Test boop</button>
        ) : (
          <button onClick={enableSound}>Enable sound</button>
        )}
      </header>
      <CopilotChat
        className="feed"
        UserMessage={DeviceAwareUserMessage}
        instructions={
          "You're the owner's assistant for their desk. A Cardputer at the desk runs a separate " +
          "AI concierge that chats with visitors while the owner is away. That traffic appears " +
          "in this chat as lines starting with '📟 [sender|s=<session id>]': visitor lines are " +
          "what people typed, concierge lines are what the device answered, owner lines are " +
          "messages already sent to the device, and event lines say when someone picked the " +
          "device up or put it back down (from its accelerometer). Several visitors can be interleaved; tell them " +
          "apart by session id and call them 'Visitor' plus the first 4 characters of it.\n\n" +
          "Lines without that prefix are the owner talking to you. Help them keep track of who " +
          "came by and what they want, and send replies to visitors with replyToVisitor when " +
          "asked (plain ASCII, short). When a device line is marked urgent, briefly tell the " +
          "owner what's going on and suggest a reply, but don't send it unless they say so. " +
          "Change the status with setStatus when the owner tells you where they are. Keep your " +
          "own messages short."
        }
        labels={{
          title: "Desk Inbox",
          initial: "Visitor messages from your desk show up here. Ask me who came by, or tell me what to reply.",
          placeholder: "Talk to your desk agent…",
        }}
      />
    </div>
  );
}

export default function Page() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" showDevConsole={false}>
      <Inbox />
    </CopilotKit>
  );
}
