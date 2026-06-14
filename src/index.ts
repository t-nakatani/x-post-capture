/**
 * X Post Capture Worker
 *
 * iOS Shortcut → POST tweet URL → fetch content via FxTwitter → create GitHub Issue
 * Supports: regular tweets, articles (long-form), media (images/videos)
 */

interface Env {
  GITHUB_TOKEN: string;
  CUSTOM_CAPTURE_SECRET: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  ISSUE_LABEL: string;
}

// --- FxEmbed API types ---

interface FxMediaEntity {
  media_id: string;
  media_info: {
    __typename: string;
    original_img_url: string;
    original_img_height: number;
    original_img_width: number;
  };
}

interface DraftBlock {
  key: string;
  text: string;
  type: string;
  inlineStyleRanges: Array<{
    offset: number;
    length: number;
    style: string;
  }>;
  entityRanges: Array<{
    key: number;
    offset: number;
    length: number;
  }>;
}

interface DraftEntity {
  key: string;
  value: {
    type: string;
    data: {
      url?: string;
      mediaItems?: Array<{ mediaId: string }>;
    };
  };
}

interface FxArticle {
  id: string;
  title: string;
  preview_text: string;
  created_at: string;
  modified_at: string;
  cover_media?: {
    media_info: {
      original_img_url: string;
      original_img_height: number;
      original_img_width: number;
    };
  };
  content: {
    blocks: DraftBlock[];
    entityMap: DraftEntity[];
  };
  media_entities?: FxMediaEntity[];
}

interface FxTweet {
  url: string;
  id: string;
  text: string;
  author: {
    name: string;
    screen_name: string;
    avatar_url: string;
  };
  replies: number;
  retweets: number;
  likes: number;
  bookmarks: number;
  created_at: string;
  created_timestamp: number;
  lang: string;
  source: string;
  media?: {
    all: Array<{
      url: string;
      type: string;
      thumbnail_url?: string;
    }>;
  };
  community_note?: { text: string } | null;
  article?: FxArticle | null;
}

interface FxTweetResponse {
  code: number;
  message: string;
  tweet: FxTweet | null;
}

/** Extract tweet ID from various URL formats */
function extractTweetId(url: string): string | null {
  const match = url.match(
    /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/
  );
  return match ? match[1] : null;
}

/** Fetch tweet content from FxTwitter API (best-effort).
 *  Falls back to Twitter syndication API if FxTwitter fails. */
async function fetchTweetContent(
  tweetId: string
): Promise<FxTweet | null> {
  // Try FxTwitter first
  try {
    const response = await fetch(
      `https://api.fxtwitter.com/i/status/${tweetId}`,
      { headers: { "User-Agent": "x-post-capture-worker/1.0" } }
    );
    if (response.ok) {
      const data = (await response.json()) as FxTweetResponse;
      if (data.code === 200 && data.tweet) return data.tweet;
    }
  } catch {
    // fall through to syndication
  }

  // Fallback: Twitter syndication API
  try {
    const response = await fetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      text?: string;
      user?: { name: string; screen_name: string; profile_image_url_https: string };
      favorite_count?: number;
      conversation_count?: number;
      created_at?: string;
      lang?: string;
      id_str?: string;
    };
    if (!data.text || !data.user) return null;
    // Map syndication format to FxTweet structure
    return {
      url: `https://x.com/${data.user.screen_name}/status/${tweetId}`,
      id: data.id_str ?? tweetId,
      text: data.text,
      author: {
        name: data.user.name,
        screen_name: data.user.screen_name,
        avatar_url: data.user.profile_image_url_https,
      },
      replies: data.conversation_count ?? 0,
      retweets: 0,
      likes: data.favorite_count ?? 0,
      bookmarks: 0,
      created_at: data.created_at ?? "",
      created_timestamp: 0,
      lang: data.lang ?? "",
      source: "",
    };
  } catch {
    return null;
  }
}

/** Check if an issue with this tweet_id already exists.
 *  Returns "duplicate" | "not_found" | "check_failed" */
async function checkDuplicate(
  env: Env,
  tweetId: string
): Promise<"duplicate" | "not_found" | "check_failed"> {
  const query = `repo:${env.GITHUB_OWNER}/${env.GITHUB_REPO} is:issue label:${env.ISSUE_LABEL} "${tweetId}" in:body`;
  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "x-post-capture-worker",
        },
      }
    );
    if (!response.ok) return "check_failed";
    const data = (await response.json()) as { total_count: number };
    return data.total_count > 0 ? "duplicate" : "not_found";
  } catch {
    return "check_failed";
  }
}

// --- Draft.js → Markdown conversion ---

/** Build a lookup from mediaId to image URL */
function buildMediaUrlMap(mediaEntities: FxMediaEntity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entity of mediaEntities) {
    map.set(entity.media_id, entity.media_info.original_img_url);
  }
  return map;
}

/** Apply inline styles (Bold) and entity ranges (LINK) to block text */
function applyInlineFormatting(
  text: string,
  inlineStyleRanges: DraftBlock["inlineStyleRanges"],
  entityRanges: DraftBlock["entityRanges"],
  entityMap: DraftEntity[]
): string {
  if (text.length === 0) return text;

  // Build a map from entity key (number) to entity value
  const entityLookup = new Map<string, DraftEntity["value"]>();
  for (const entry of entityMap) {
    entityLookup.set(entry.key, entry.value);
  }

  // Collect all annotations sorted by offset (process right-to-left to preserve indices)
  const annotations: Array<{
    offset: number;
    length: number;
    type: "bold" | "link";
    url?: string;
  }> = [];

  for (const style of inlineStyleRanges) {
    if (style.style === "Bold") {
      annotations.push({ offset: style.offset, length: style.length, type: "bold" });
    }
  }

  for (const range of entityRanges) {
    const entity = entityLookup.get(String(range.key));
    if (entity?.type === "LINK" && entity.data.url) {
      annotations.push({
        offset: range.offset,
        length: range.length,
        type: "link",
        url: entity.data.url,
      });
    }
  }

  // Sort by offset descending so replacements don't shift indices
  annotations.sort((a, b) => b.offset - a.offset);

  let result = text;
  for (const ann of annotations) {
    const before = result.slice(0, ann.offset);
    const segment = result.slice(ann.offset, ann.offset + ann.length);
    const after = result.slice(ann.offset + ann.length);

    if (ann.type === "bold") {
      result = `${before}**${segment}**${after}`;
    } else if (ann.type === "link" && ann.url) {
      result = `${before}[${segment}](${ann.url})${after}`;
    }
  }

  return result;
}

/** Convert Draft.js blocks to Markdown lines */
function draftBlocksToMarkdown(
  blocks: DraftBlock[],
  entityMap: DraftEntity[],
  mediaUrlMap: Map<string, string>
): string {
  // Build entity key lookup for MEDIA references
  const entityLookup = new Map<string, DraftEntity["value"]>();
  for (const entry of entityMap) {
    entityLookup.set(entry.key, entry.value);
  }

  const lines: string[] = [];

  for (const block of blocks) {
    // Handle atomic blocks (media embeds)
    if (block.type === "atomic") {
      for (const range of block.entityRanges) {
        const entity = entityLookup.get(String(range.key));
        if (entity?.type === "MEDIA" && entity.data.mediaItems) {
          for (const item of entity.data.mediaItems) {
            const url = mediaUrlMap.get(item.mediaId);
            if (url) {
              lines.push(`![article image](${url})`);
              lines.push("");
            }
          }
        }
      }
      continue;
    }

    const formatted = applyInlineFormatting(
      block.text,
      block.inlineStyleRanges,
      block.entityRanges,
      entityMap
    );

    switch (block.type) {
      case "header-one":
        lines.push(`# ${formatted}`);
        lines.push("");
        break;
      case "header-two":
        lines.push(`## ${formatted}`);
        lines.push("");
        break;
      case "header-three":
        lines.push(`### ${formatted}`);
        lines.push("");
        break;
      case "unordered-list-item":
        lines.push(`- ${formatted}`);
        break;
      case "ordered-list-item":
        lines.push(`1. ${formatted}`);
        break;
      case "blockquote":
        lines.push(`> ${formatted}`);
        lines.push("");
        break;
      default:
        // unstyled or unknown — plain paragraph
        if (formatted.length > 0) {
          lines.push(formatted);
          lines.push("");
        }
        break;
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Format issue body for an article post */
function formatArticleBody(tweet: FxTweet, article: FxArticle): string {
  const lines: string[] = [];

  // Cover image
  if (article.cover_media) {
    lines.push(`![cover](${article.cover_media.media_info.original_img_url})`);
    lines.push("");
  }

  // Author + date
  lines.push(
    `**${tweet.author.name}** ([@${tweet.author.screen_name}](https://x.com/${tweet.author.screen_name})) · ${article.created_at}`
  );
  lines.push("");

  // Article body (Draft.js → Markdown)
  const mediaUrlMap = buildMediaUrlMap(article.media_entities ?? []);
  const articleMarkdown = draftBlocksToMarkdown(
    article.content.blocks,
    article.content.entityMap,
    mediaUrlMap
  );
  lines.push(articleMarkdown);

  // Engagement
  lines.push("");
  lines.push("---");
  lines.push("### Engagement");
  lines.push(
    `Likes: ${tweet.likes} · RT: ${tweet.retweets} · Replies: ${tweet.replies} · Bookmarks: ${tweet.bookmarks}`
  );

  // Metadata
  lines.push("");
  lines.push(`**URL**: ${tweet.url}`);
  lines.push(`**Tweet ID**: ${tweet.id}`);
  lines.push(`**Article ID**: ${article.id}`);

  return lines.join("\n");
}

/** Format issue body - rich version (when FxTwitter succeeds) */
function formatRichBody(tweet: FxTweet): string {
  const lines: string[] = [];

  lines.push(`> ${tweet.text.replace(/\n/g, "\n> ")}`);
  lines.push("");
  lines.push(
    `— **${tweet.author.name}** ([@${tweet.author.screen_name}](https://x.com/${tweet.author.screen_name})) · ${tweet.created_at}`
  );
  lines.push("");
  lines.push("### Engagement");
  lines.push(
    `Likes: ${tweet.likes} · RT: ${tweet.retweets} · Replies: ${tweet.replies} · Bookmarks: ${tweet.bookmarks}`
  );

  if (tweet.media?.all?.length) {
    lines.push("");
    lines.push("### Media");
    for (const m of tweet.media.all) {
      if (m.type === "photo" || m.type === "image") {
        lines.push(`![media](${m.url})`);
      } else {
        lines.push(`- [${m.type}](${m.url})`);
      }
    }
  }

  if (tweet.community_note) {
    lines.push("");
    lines.push(`### Community Note`);
    lines.push(tweet.community_note.text);
  }

  lines.push("");
  lines.push("---");
  lines.push(`**URL**: ${tweet.url}`);
  lines.push(`**Tweet ID**: ${tweet.id}`);
  lines.push(`**Lang**: ${tweet.lang} · **Source**: ${tweet.source}`);

  return lines.join("\n");
}

/** Format issue body - URL-only fallback */
function formatUrlOnlyBody(tweetUrl: string, tweetId: string): string {
  return [
    "*(FxTwitter で内容を取得できませんでした)*",
    "",
    `**URL**: ${tweetUrl}`,
    `**Tweet ID**: ${tweetId}`,
  ].join("\n");
}

/** Create GitHub Issue */
async function createIssue(
  env: Env,
  title: string,
  body: string
): Promise<{ url: string; number: number }> {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "x-post-capture-worker",
      },
      body: JSON.stringify({
        title,
        body,
        labels: [env.ISSUE_LABEL],
      }),
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text}`);
  }
  const data = (await response.json()) as {
    html_url: string;
    number: number;
  };
  return { url: data.html_url, number: data.number };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, X-Custom-Capture-Secret",
        },
      });
    }

    if (request.method !== "POST") {
      return Response.json(
        { error: "Method not allowed" },
        { status: 405 }
      );
    }

    // Auth check
    const customCaptureSecret = request.headers.get("X-Custom-Capture-Secret");
    if (!customCaptureSecret || customCaptureSecret !== env.CUSTOM_CAPTURE_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse request
    let tweetUrl: string;
    try {
      const body = (await request.json()) as Record<string, unknown>;
      if (!body.url || typeof body.url !== "string") {
        return Response.json(
          { error: "Missing or invalid 'url' field (must be a string)" },
          { status: 400 }
        );
      }
      tweetUrl = body.url;
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    // Extract tweet ID
    const tweetId = extractTweetId(tweetUrl);
    if (!tweetId) {
      return Response.json(
        { error: "Could not extract tweet ID from URL" },
        { status: 400 }
      );
    }

    // Duplicate check (fail-closed: if check fails, reject rather than create duplicates)
    const dupResult = await checkDuplicate(env, tweetId);
    if (dupResult === "duplicate") {
      return Response.json(
        { status: "duplicate", message: "This tweet has already been captured" },
        { status: 200 }
      );
    }
    if (dupResult === "check_failed") {
      return Response.json(
        { error: "Duplicate check failed (GitHub Search API unavailable). Try again later." },
        { status: 503 }
      );
    }

    // Fetch tweet content (best-effort)
    const tweet = await fetchTweetContent(tweetId);

    // Build issue
    let title: string;
    let body: string;
    const hasArticle = tweet?.article != null;

    if (tweet && hasArticle) {
      // Article post
      const articleTitle = tweet.article!.title.trim();
      title = `[X Article] @${tweet.author.screen_name}: ${articleTitle.length > 60 ? articleTitle.slice(0, 57) + "..." : articleTitle}`;
      body = formatArticleBody(tweet, tweet.article!);
    } else if (tweet) {
      // Regular tweet
      const truncatedText =
        tweet.text.length > 60
          ? tweet.text.slice(0, 57) + "..."
          : tweet.text;
      title = `[X] @${tweet.author.screen_name}: ${truncatedText}`;
      body = formatRichBody(tweet);
    } else {
      title = `[X] ${tweetId}`;
      body = formatUrlOnlyBody(tweetUrl, tweetId);
    }

    // Create issue
    try {
      const issue = await createIssue(env, title, body);
      return Response.json({
        status: "ok",
        issue_url: issue.url,
        issue_number: issue.number,
        content_fetched: tweet !== null,
        has_article: hasArticle,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return Response.json(
        { error: `Failed to create issue: ${message}` },
        { status: 502 }
      );
    }
  },
};
