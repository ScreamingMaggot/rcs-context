// Probe Spark x2.6 reasoning behavior in "off" mode. Prints message keys and any
// reasoning channel; never prints the API key.
const ENDPOINT = 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions'
const KEY = process.env.SPARK_API_KEY
if (!KEY) throw new Error('SPARK_API_KEY missing')
const PROMPT = '只输出 JSON：{"answer": 2}。不要解释。问题是：1+1 等于几？'
const VARIANTS = [
  { name: 'reasoning_effort_none', extra: { reasoning_effort: 'none' } },
  { name: 'omit_reasoning', extra: {} },
  { name: 'thinking_disabled', extra: { reasoning_effort: 'none', thinking: { type: 'disabled' } } },
  { name: 'enable_thinking_false', extra: { reasoning_effort: 'none', enable_thinking: false } },
]

for (const variant of VARIANTS) {
  const started = Date.now()
  let response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'spark-x2.6',
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 0,
        max_tokens: 256,
        stream: false,
        ...variant.extra,
      }),
      signal: AbortSignal.timeout(120000),
    })
  } catch (error) {
    console.log(JSON.stringify({ variant: variant.name, transportError: String(error?.message ?? error) }))
    continue
  }
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* keep text */ }
  if (!response.ok) {
    console.log(JSON.stringify({
      variant: variant.name,
      status: response.status,
      error: body ?? text.slice(0, 500),
      elapsedMs: Date.now() - started,
    }))
    continue
  }
  const message = body?.choices?.[0]?.message ?? {}
  const reasoning = message.reasoning_content ?? message.reasoning ?? null
  console.log(JSON.stringify({
    variant: variant.name,
    status: response.status,
    elapsedMs: Date.now() - started,
    bodyKeys: Object.keys(body ?? {}),
    messageKeys: Object.keys(message),
    finishReason: body?.choices?.[0]?.finish_reason ?? null,
    content: typeof message.content === 'string' ? message.content.slice(0, 300) : null,
    reasoningContent: typeof reasoning === 'string' ? reasoning.slice(0, 600) : null,
    reasoningLength: typeof reasoning === 'string' ? reasoning.length : 0,
    usage: body?.usage ?? null,
  }, null, 2))
}
