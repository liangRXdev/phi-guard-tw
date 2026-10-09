# phi-guard-tw

[繁體中文](README.md)

A Claude Code mod (a function-hooks plugin) that masks Taiwanese patient identifiers **with fixed formats** before the model reads them. Masking stops depending on the model remembering to do it. Code enforces it.

> ⚠ **This is a safety net. It does not guarantee de-identification.**
> It only catches fixed-format fields: national ID and resident certificate numbers (verified by check digit), plus medical record numbers and NHI card numbers when they carry a label. It does **not** handle names, addresses or phone numbers. Installing it does not make you compliant with Taiwan's Personal Data Protection Act or your institution's policy.
>
> **This is a personal tool. Forks are welcome, but no support is promised.** Tested with Claude Code 2.1.292–2.1.295. The mod API is early access, so run `claude plugin test` after upgrading Claude Code.

## Install

```
/plugin install phi-guard-tw --marketplace liangRXdev/phi-guard-tw
```

## What it does

- **`session.append`**: masks every row before it enters the conversation. That covers tool results, MCP output, attachments, prompts and subagent conversations.
- **`prompt.submit`**: masks your prompt before it is sent. A toast reports the field types and counts it masked, never the values.
- **`tool.call`**:
  - Blocks Read on images and PDFs under sensitive directories. It checks both the literal path and the resolved real path, so a symlink cannot route around it.
  - Blocks write-capable tools whose input contains mask tokens, so masked values are never written back over the source data.
- **Fail-closed**: when masking itself fails, the row's content is replaced with a placeholder, the prompt is dropped, or the tool call is denied.

## What it masks

| Field | How it is detected | Masked as |
|---|---|---|
| National ID, resident certificate (new and old format) | Regex plus check digit; full-width and lowercase forms are caught | First 3 chars + `****` + last 2 |
| Medical record number | **Labeled values only**: `病歷號`, `病歷號碼`, `MRN`, `ChartNo`, `chart_no`, plus your `extraMrnLabels`. The label is followed by `:`, `：`, `=` or whitespace, or it names a table column (CSV, TSV, Markdown, or a JSON 2-D array) | First 2 + `****` + last 2; values of 6 characters or fewer become `****` |
| NHI card number | Same rule, with the labels `健保卡號` and `健保卡號碼` | Same |

## Configuration (userConfig)

| Field | Default | Meaning |
|---|---|---|
| `extraMrnLabels` | empty | Extra labels for medical record numbers. Matched as **literal text**, not regex. Entries shorter than 2 characters are ignored. |
| `sensitiveDirs` | `00_private`, `private`, `phi` | Read on images and PDFs is blocked when the path contains one of these directory names (case-insensitive). |
| `exemptMaskExamples` | empty | Mask tokens that may still be written, such as format examples in documentation. |
| `readOnlyMcpTools` | Google Sheets `get_values`, `get_spreadsheet` | MCP tools allowed even when their input contains mask tokens. This list replaces the default. Any MCP tool not listed is treated as write-capable. |

## Limitations

- Not handled: names, addresses, phones and birthdays; unlabeled record numbers; IDs written with separators; base64 or URL-encoded content.
- Table-column masking depends on the header row. Partial output such as Grep or `head` has no header, so those columns are not masked.
- Image pixels and non-text documents cannot be scanned.
- Block types the engine does not recognize are put back unchanged by the engine, so the mod cannot touch them.
- The tool result's structured record (what the screen shows) is stored unmasked in the local transcript file. The model does not read it, but it stays on your disk.
- Conversations loaded with `--resume` are not re-masked.

See the Chinese README for the full list.

## License

MIT. This software provides no medical, legal or security advice. Use it at your own risk.
