/**
 * Gemini implementation of `LLMProvider`, using Google's
 * `generateContent` REST endpoint directly (no SDK dependency), mirroring
 * the shape of `GroqProvider`.
 */

import { LLMProviderError, parseDecisionResponse, type LLMDecisionRequest, type LLMDecisionResponse, type LLMProvider } from './provider.js';

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: GeminiProviderOptions) {
    if (!opts.apiKey) throw new Error('GeminiProvider requires an apiKey (GEMINI_API_KEY)');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async decide(request: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/models/${this.model}:generateContent`, {
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 300,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Gemini API returned ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const content = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
      if (!content) throw new Error('Gemini API response had no content');

      return parseDecisionResponse(content);
    } catch (err) {
      throw new LLMProviderError(this.name, err);
    }
  }
}
