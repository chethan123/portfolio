# Third-party skills

The skills in this directory (except this file) are vendored from
[mattpocock/skills](https://github.com/mattpocock/skills), commit
`0ab1b63a410a03d3627979a109c8695de27af954`, from the `skills/engineering`
and `skills/productivity` categories.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Several of these skills (`code-review`, `setup-matt-pocock-skills`, `to-spec`,
`to-tickets`, `triage`, `wayfinder`) assume repo conventions the upstream
project sets up via its own `setup-matt-pocock-skills` skill (an issue
tracker location, triage labels, `CONTEXT.md`/ADR layout). Run
`$setup-matt-pocock-skills` once, or ignore those skills, before relying on
them.

**Naming note:** this repo already has a built-in `code-review` skill
(diff-review with `--comment`/`--fix` flags). The vendored `code-review`
skill here has the same name but a different, Standards+Spec-based review
process — the project-level copy takes precedence when both are present.
Rename or remove one if the collision is unwanted.
