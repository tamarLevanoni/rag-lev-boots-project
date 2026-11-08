
import type { ContentBlock, NormalizedDocument } from "../types";

const BASE_URL = "https://lev-boots-slack-api.jona-581.workers.dev/";

const CHANNELS = [
  "lab-notes",
  "engineering",
  "offtopic",
] as const;

interface SlackMessage {
  id: string;
  channel: string;
  user: string;
  role: string;
  ts: string;
  text: string;
  thread_ts: string;
}

interface SlackResponse {
  channel: string;
  page: number;
  limit: number;
  total: number;
  items: SlackMessage[];
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(
  url: string,
  maxRetries = 5
): Promise<SlackResponse> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url);

    if (response.ok) {
      return (await response.json()) as SlackResponse;
    }

    const retryable =
      response.status === 429 ||
      response.status >= 500;

    if (!retryable || attempt === maxRetries) {
      throw new Error(
        `Request failed: HTTP ${response.status}, ${url}`
      );
    }

    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter === null
      ? NaN
      : Number(retryAfter);

    const delay =
      response.status === 429 &&
      Number.isFinite(seconds) &&
      seconds >= 0
        ? seconds * 1000
        : Math.min(1000 * 2 ** attempt, 30000);

    console.log(
      `HTTP ${response.status}. Retrying in ${delay}ms...`
    );

    await sleep(delay);
  }

  throw new Error("Unexpected retry failure");
}

async function loadChannel(
  channel: string
): Promise<NormalizedDocument[]> {
  const documents: NormalizedDocument[] = [];
  const seenIds = new Set<string>();

  let page = 1;
  let total = 0;

  while (true) {
    const url = new URL(BASE_URL);
    url.searchParams.set("channel", channel);
    url.searchParams.set("page", String(page));

    const result = await fetchWithRetry(url.toString());

    if (result.channel !== channel) {
      throw new Error(`Unexpected channel: ${result.channel}`);
    }

    if (!Number.isFinite(result.total) || result.total < 0) {
      throw new Error("Invalid total from Slack API");
    }

    total = result.total;

    console.log(
      `${channel}: page ${page}, received ${result.items.length}/${total}`
    );

    if (result.items.length === 0) {
      if (documents.length < total) {
        throw new Error(
          `${channel}: empty page before all messages were loaded`
        );
      }
      break;
    }

    for (const message of result.items) {
      if (seenIds.has(message.id)) {
        throw new Error(
          `Duplicate message in ${channel}: ${message.id}`
        );
      }

      seenIds.add(message.id);

      documents.push({
        source: "slack",
        sourceId: `${channel}:${message.id}`,
        content: message.text,
        metadata: {
          channel,
          user: message.user,
          timestamp: message.ts,
          threadTs: message.thread_ts,
        },
      });
    }

    if (documents.length >= total) break;

    page++;
  }

  if (documents.length !== total) {
    throw new Error(
      `${channel}: expected ${total}, got ${documents.length}`
    );
  }

  console.log(`✓ ${channel}: ${documents.length} messages loaded`);

  return documents;
}


export async function loadSlackMessages(): Promise<NormalizedDocument[]> {
  const messages: NormalizedDocument[] = [];

  // Fetch all messages from all channels
  for (const channel of CHANNELS) {
    const channelMessages = await loadChannel(channel);
    messages.push(...channelMessages);
  }

  // Group messages by channel + thread
  const threads = new Map<string, NormalizedDocument[]>();

  for (const message of messages) {
    const channel = message.metadata?.channel;
    const threadId =
      message.metadata?.threadTs || message.sourceId.split(":").at(-1);

    const key = `${channel}:${threadId}`;

    if (!threads.has(key)) {
      threads.set(key, []);
    }

    threads.get(key)!.push(message);
  }

  // Convert each thread into one document
  const documents: NormalizedDocument[] = [];

  for (const [threadKey, threadMessages] of threads) {
    threadMessages.sort((a, b) =>
      (a.metadata?.timestamp ?? "").localeCompare(
        b.metadata?.timestamp ?? ""
      )
    );

    const blocks: ContentBlock[] = threadMessages.map(message => ({
      kind: "message",
      speaker: message.metadata?.user ?? "Unknown",
      text: `${message.metadata?.user ?? "Unknown"}: ${message.content.trim()}`,
    }));
    const threadId = threadKey.substring(threadKey.indexOf(":") + 1);
    const rootIndex = threadMessages.findIndex(message =>
      message.metadata?.timestamp === threadId || message.sourceId.split(":").at(-1) === threadId
    );

    documents.push({
      source: "slack",
      sourceId: `thread:${threadKey}`,
      content: blocks.map(block => block.text).join("\n\n"),
      blocks,
      openingMessage: rootIndex < 0 ? undefined : blocks[rootIndex].text,
      metadata: {
        channel: threadMessages[0].metadata?.channel,
        threadTs: threadKey.substring(threadKey.indexOf(":") + 1),
      },
    });
  }

  console.log(`Original messages: ${messages.length}`);
  console.log(`Grouped threads: ${documents.length}`);

  return documents;
}

