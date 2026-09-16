/**
 * Gemini implementation of `LLMProvider`, using Google's
 * `generateContent` REST endpoint directly (no SDK dependency), mirroring
 * the shape of `GroqProvider` — including its second role as an
 * `LLMCompletionProvider` for the game designer.
 */

import {
  LLMProviderError,
  parseDecisionResponse,
  type LLMCompletionProvider,
  type LLMCompletionRequest,
  type LLMDecisionRequest,
  type LLMDecisionResponse,
  type LLMProvider,
} from './provider.js';

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

interface GenerateRequest {
  readonly temperature: number;
  readonly maxTokens: number;
  readonly json: boolean;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly signal: AbortSignal;
}

export class GeminiProvider implements LLMProvider, LLMCompletionProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: GeminiProviderOptions) {
    if (!opts.apiKey) throw new Error('GeminiProvider requires an apiKey (GEMINI_API_KEY)');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async decide(request: LLMDecisionRequest): Promise<LLMDecisionResponse> {
    const content = await this.generate({
      temperature: 0.3,
      maxTokens: 300,
      json: true,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      signal: request.signal,
    });
    return parseDecisionResponse(content);
  }

  async complete(request: LLMCompletionRequest): Promise<string> {
    return this.generate({
      temperature: request.temperature ?? 0.4,
      maxTokens: request.maxTokens,
      json: request.json ?? false,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      signal: request.signal,
    });
  }

  /** Shared transport for both public methods, mirroring `GroqProvider.chat`. */
  private async generate(request: GenerateRequest): Promise<string> {
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
            temperature: request.temperature,
            maxOutputTokens: request.maxTokens,
            ...(request.json ? { responseMimeType: 'application/json' } : {}),
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

      return content;
    } catch (err) {
      throw new LLMProviderError(this.name, err);
    }
  }
}
