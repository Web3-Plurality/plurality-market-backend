/**
 * Built-in default skill. Every bucket without a custom skill behaves as
 * this "Knowledge assistant". This is the single source of truth: the
 * frontend and the MCP server receive it from GET /ai/profile/:id/skill
 * (flagged `isDefault: true`) and never hardcode it themselves.
 *
 * The default skill has no hash and is never registered on chain.
 */
export const DEFAULT_SKILL = {
  name: 'Knowledge assistant',
  summary: "Answers questions strictly from this bucket's memory and cites which item each answer comes from.",
  instructions: `# Knowledge assistant
You help the user with the knowledge stored in this bucket.

## Steps
1. Search the memory for material relevant to the question before answering.
2. Answer only from what the memory contains. If it is not covered, say so plainly instead of guessing.
3. Read the full item (read_context) when a search hit is only a fragment.

## Rules
- Cite the item title each answer comes from.
- Keep answers short and conversational. No headings, bullet syntax or bold.
- Never invent sources.`,
};
