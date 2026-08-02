---
'just-another-sdk': minor
---

The built-in tool pack — seventeen tools in the box.

`npm i just-another-sdk` now gives you an agent that can already _do_ things,
rather than a set of interfaces to implement.

**Five pure tools are on every agent**, with nothing imported and nothing
configured:

```ts
new Agent({ name: 'assistant', model }).toolNames
// ['calculate', 'current_time', 'date_math', 'unit_convert', 'think']
```

`calculate` is a recursive-descent parser with **no `eval` and no `Function`** —
the three-line version of a calculator tool hands a language model a
general-purpose code execution primitive, and a prompt injection in a fetched web
page is enough to reach it. `date_math` gets month-end and leap years right;
`unit_convert` refuses a cross-dimension conversion rather than inventing a
number.

They cost **~732 tokens per request**, which a test pins so the figure in the
docs cannot drift from the code. Opt out with `builtins: false`. **A tool of your
own with the same name silently replaces a built-in**, so this can never collide
with something you already wrote.

**Real data with no API key**, one line, no configuration:

```ts
import { webTools } from 'just-another-sdk/tools'

tools: [...webTools()] // get_weather, geocode, wikipedia, currency_convert
```

Open-Meteo, Wikipedia, and European Central Bank rates. Each hits one fixed
endpoint the model cannot change — it supplies a query, never a host — which is
exactly why these need no allowlist and have no SSRF surface.

**Anything that lets the model choose a host or a path is locked down:**

```ts
import { httpFetch, readUrl, webSearch } from 'just-another-sdk/tools'
import { fileTools } from 'just-another-sdk/tools/fs'

httpFetch({ allow: ['api.example.com'] })
fileTools({ root: './workspace', write: true })
```

- An allowlist is **required**; there is no permissive default.
- Private, loopback, link-local, and cloud-metadata addresses are refused **even
  when the allowlist says `*`** — `169.254.169.254` returns your cloud role's
  credentials, and that is not an intent question.
- **Every redirect hop is re-checked**, because an allowed host that `302`s to
  `127.0.0.1` is the oldest trick there is.
- Filesystem paths are resolved to a **real** path and asserted inside the root,
  so a symlink pointing out is caught — normalising `..` alone would not.
- `edit_file` refuses an ambiguous match rather than editing the first of four.

`webSearch(client)` takes the search vendor you already use, structurally, the
same way `redisSession(client)` does — no vendor becomes a dependency.

Also: `Agent.builtins`, `PURE_BUILTINS`, and a `tool-sandbox` test suite whose
entire job is proving the dangerous paths **fail** — traversals, planted
symlinks, eleven blocked address forms, and redirect escapes.

Zero runtime dependencies, still. Input schemas are validated by a small internal
Standard Schema implementation, because the SDK cannot import Zod to describe its
own parameters.
