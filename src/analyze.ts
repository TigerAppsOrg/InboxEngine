/** Stateless pipeline run for callers that bring their own email (API + MCP `analyze_email`). */
import { readableText, looksLikeHtml, resolveSender, extractLinks } from './core/index.ts';
import { classifyMessage } from './orgs/index.ts';
import { extractEvents } from './events/index.ts';
import { organizationPayload } from './queries.ts';
import { getOrganization } from './orgs/index.ts';

export type AnalyzeInput = {
  subject: string;
  body: string;
  sentAt: string;
  senderName?: string;
  senderEmail?: string;
  listserv?: string;
};

export async function analyzeEmail(input: AnalyzeInput) {
  const sentAt = new Date(input.sentAt);
  if (!Number.isFinite(sentAt.getTime())) throw new Error('sent_at must be an ISO timestamp');
  const html = looksLikeHtml(input.body) ? input.body : null;
  const body = readableText(html ? '' : input.body, html);
  const sender = resolveSender({ name: input.senderName, email: input.senderEmail, body, bodyHtml: html });
  const classification = classifyMessage({
    subject: input.subject,
    body,
    sender: sender.name,
    senderEmail: sender.email,
    listserv: input.listserv?.toUpperCase()
  });
  const extraction = await extractEvents({
    subject: input.subject,
    body,
    sentAt,
    links: html ? extractLinks(html) : [],
    listserv: input.listserv?.toUpperCase(),
    organizationId: classification.organizationId,
    organizationName: classification.organizationId ? classification.organization : null
  });
  return {
    sender,
    organization: classification.organizationId
      ? { ...organizationPayload(getOrganization(classification.organizationId), classification.organizationId), confidence: classification.confidence, evidence: classification.evidence }
      : null,
    category: classification.category,
    extraction
  };
}
