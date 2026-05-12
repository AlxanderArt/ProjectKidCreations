<!-- ────────────────────────────────────────────────────────────
  PKC PRESET — README TEMPLATE
  Sed-substitute the {{VARS}} below to render README.md.
  Variables are sourced from the question battery + detection.
  Visible URLs, IDs, hostnames are FORBIDDEN here.
──────────────────────────────────────────────────────────── -->

```
{{HERO_LINES}}
```

<div align="center">

<sub>// STATUS</sub>

{{BADGE_ROW_DYNAMIC}}

<sub>// STACK</sub>

{{BADGE_ROW_STACK}}

<sub>// LICENSE</sub>

{{BADGE_ROW_LICENSE}}

</div>

---

## // {{PROJECT_NAME}}

{{ONE_PARAGRAPH_WHAT}}

---

## // SYSTEM_MAP

{{TIER_DESCRIPTION}}

```mermaid
{{COMPONENT_FLOWCHART}}
```

---

## // ENDPOINTS

{{ENDPOINT_TABLE}}

> Public surface only. Hostnames live outside the repo.

---

## // PHASE_FLOW

```mermaid
{{FLOW_SEQUENCE}}
```

{{ALGORITHM_NOTES}}

**Logical profile fields:** {{LOGICAL_FIELDS}}

---

## // DESIGN_DECISIONS

{{DESIGN_DECISIONS}}

---

## // FILES

{{FILE_INDEX}}

---

## // GOTCHAS

{{GOTCHAS}}

---

## // LICENSE

{{LICENSE_LINE}}
