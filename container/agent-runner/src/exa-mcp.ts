/**
 * MCP server in-process pour Exa search API.
 * Fournit web_search, answer, get_contents, find_similar.
 * Remplace le WebSearch/WebFetch natif du SDK (plus cher, moins pertinent).
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

const EXA_API_KEY = process.env.EXA_API_KEY;
const EXA_BASE = 'https://api.exa.ai';

async function exaFetch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  if (!EXA_API_KEY) throw new Error('EXA_API_KEY not configured');
  const res = await fetch(`${EXA_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'x-api-key': EXA_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa API error ${res.status}: ${text}`);
  }
  return res.json();
}

const webSearch = tool(
  'web_search',
  `Search the web using Exa's AI-native search engine. Returns relevant web pages with clean content.
Use this for any web search query. Much better results than generic search engines for factual and business queries.

Tips:
- For company research, include the company name and "site:linkedin.com" or similar
- For recent news, use start_published_date
- For specific domains, use include_domains`,
  {
    query: z.string().describe('Search query'),
    num_results: z.number().optional().default(5).describe('Number of results (1-10, default 5)'),
    start_published_date: z.string().optional().describe('Filter: only results published after this date (ISO format, e.g. 2026-01-01)'),
    include_domains: z.array(z.string()).optional().describe('Only include results from these domains (e.g. ["linkedin.com", "lemonde.fr"])'),
    exclude_domains: z.array(z.string()).optional().describe('Exclude results from these domains'),
    category: z.enum(['general', 'company', 'news', 'research paper', 'tweet', 'personal site', 'pdf']).optional()
      .describe('Filter by content category'),
    use_deep_search: z.boolean().optional().default(false).describe('Use deep search for better results (slower, ~2-3s)'),
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = {
        query: args.query,
        numResults: Math.min(args.num_results || 5, 10),
        contents: {
          text: { maxCharacters: 2000 },
          highlights: { numSentences: 3 },
        },
        type: args.use_deep_search ? 'deep' : 'auto',
      };
      if (args.start_published_date) body.startPublishedDate = args.start_published_date;
      if (args.include_domains) body.includeDomains = args.include_domains;
      if (args.exclude_domains) body.excludeDomains = args.exclude_domains;
      if (args.category) body.category = args.category;

      const data = await exaFetch('/search', body) as {
        results: Array<{
          title: string;
          url: string;
          publishedDate?: string;
          author?: string;
          text?: string;
          highlights?: string[];
        }>;
      };

      // Format results for the agent
      const formatted = data.results.map((r, i) => {
        let entry = `## ${i + 1}. ${r.title}\n${r.url}`;
        if (r.publishedDate) entry += ` (${r.publishedDate.split('T')[0]})`;
        if (r.author) entry += ` — ${r.author}`;
        if (r.highlights?.length) entry += `\n> ${r.highlights.join('\n> ')}`;
        if (r.text) entry += `\n\n${r.text.slice(0, 1500)}`;
        return entry;
      }).join('\n\n---\n\n');

      return {
        content: [{ type: 'text', text: formatted || 'Aucun résultat trouvé.' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Erreur recherche: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

const answer = tool(
  'answer',
  `Get a direct answer to a question with citations from the web.
Like a mini Perplexity — Exa searches, reads pages, and synthesizes an answer.
Best for factual questions where you want a quick, sourced response.
Do NOT use this for broad research — use web_search instead.`,
  {
    query: z.string().describe('Question to answer'),
  },
  async (args) => {
    try {
      const data = await exaFetch('/answer', {
        query: args.query,
        text: true,
      }) as {
        answer: string;
        citations: Array<{ title: string; url: string }>;
      };

      let text = data.answer || 'Pas de réponse trouvée.';
      if (data.citations?.length) {
        text += '\n\nSources:\n' + data.citations.map((c, i) => `${i + 1}. [${c.title}](${c.url})`).join('\n');
      }

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Erreur: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

const getContents = tool(
  'get_contents',
  `Extract clean text content from one or more URLs. Returns markdown-formatted text.
Use this to read a specific web page when you know the URL.
Much cleaner than WebFetch — returns AI-ready content without boilerplate.`,
  {
    urls: z.array(z.string()).describe('URLs to extract content from (max 5)'),
  },
  async (args) => {
    try {
      const data = await exaFetch('/contents', {
        ids: args.urls.slice(0, 5),
        text: { maxCharacters: 5000 },
      }) as {
        results: Array<{ title: string; url: string; text?: string }>;
      };

      const formatted = data.results.map(r =>
        `## ${r.title}\n${r.url}\n\n${r.text || '[Contenu non disponible]'}`
      ).join('\n\n---\n\n');

      return { content: [{ type: 'text', text: formatted || 'Aucun contenu extrait.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Erreur: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

const findSimilar = tool(
  'find_similar',
  `Find web pages similar to a given URL. Useful for competitive analysis, finding alternatives, or discovering related content.`,
  {
    url: z.string().describe('URL to find similar pages for'),
    num_results: z.number().optional().default(5).describe('Number of results (1-10)'),
    include_domains: z.array(z.string()).optional().describe('Only include results from these domains'),
    exclude_domains: z.array(z.string()).optional().describe('Exclude results from these domains'),
  },
  async (args) => {
    try {
      const data = await exaFetch('/findSimilar', {
        url: args.url,
        numResults: Math.min(args.num_results || 5, 10),
        contents: {
          text: { maxCharacters: 1000 },
          highlights: { numSentences: 2 },
        },
      }) as {
        results: Array<{ title: string; url: string; text?: string; highlights?: string[] }>;
      };

      const formatted = data.results.map((r, i) => {
        let entry = `${i + 1}. **${r.title}**\n   ${r.url}`;
        if (r.highlights?.length) entry += `\n   > ${r.highlights.join(' ')}`;
        return entry;
      }).join('\n\n');

      return { content: [{ type: 'text', text: formatted || 'Aucune page similaire trouvée.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Erreur: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

export const exaServer = createSdkMcpServer({
  name: 'exa',
  version: '1.0.0',
  tools: [webSearch, answer, getContents, findSimilar],
});
