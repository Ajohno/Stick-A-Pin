function summarizeReportUrl(value) {
  if (typeof value !== "string" || value.length > 4096) {
    return "unknown";
  }

  // These describe blocked content without identifying a URL.
  if (["inline", "eval", "wasm-eval", "self"].includes(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    // Keep only the origin, excluding credentials, paths, queries, and fragments.
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.origin;
    }

    // Never include embedded data or blob identifiers.
    if (url.protocol === "data:" || url.protocol === "blob:") {
      return url.protocol;
    }
  } catch {
    // Missing or malformed URLs do not belong in the log.
  }

  return "unknown";
}

function normalizeCspReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return null;
  }

  const directive =
    report["effective-directive"] ?? report.effectiveDirective;

  if (
    typeof directive !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(directive)
  ) {
    return null;
  }

  return {
    directive,
    documentOrigin: summarizeReportUrl(
      report["document-uri"] ?? report.documentURL
    ),
    blockedOrigin: summarizeReportUrl(
      report["blocked-uri"] ?? report.blockedURL
    ),
    disposition: ["enforce", "report"].includes(report.disposition)
      ? report.disposition
      : "unknown",
  };
}

function createCspReportHandler({ logger = console } = {}) {
  return function handleCspReport(req, res) {
    let reports;

    if (req.is("application/csp-report")) {
      reports = [req.body?.["csp-report"]];
    } else if (req.is("application/reports+json")) {
      if (!Array.isArray(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "Invalid report payload" });
      }

      if (req.body.length > 10) {
        return res.status(413).json({ error: "Too many reports" });
      }

      reports = [];

      for (const entry of req.body) {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.type !== "string"
        ) {
          return res.status(400).json({ error: "Invalid report payload" });
        }

        // The Reporting API can carry other report types.
        if (entry.type === "csp-violation") {
          reports.push(entry.body);
        }
      }
    } else {
      return res.status(415).json({ error: "Unsupported report type" });
    }

    const summaries = reports.map(normalizeCspReport);

    // Validate the complete batch before emitting any events.
    if (summaries.some((summary) => summary === null)) {
      return res.status(400).json({ error: "Invalid report payload" });
    }

    for (const summary of summaries) {
      logger.info(JSON.stringify({
        event: "csp_violation",
        timestamp: new Date().toISOString(),
        ...summary,
      }));
    }

    return res.status(204).end();
  };
}
module.exports = { normalizeCspReport, createCspReportHandler };