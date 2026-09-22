// Decorate saved downloads without execution or source calls.
export function attachReportLinks(result, base) {
        const documents = [result.context_view, ...(result.context_view?.conversation || []).map(turn => turn.output), result.result, ...(result.context_view?.results || []), ...(result.context_view?.conversation || []).flatMap(turn => [turn.output?.result, ...(turn.output?.results || [])])];
        for (const document of documents) {
          const reportPath = document?.report?.download_path;
          if (typeof reportPath === 'string' && /^\/v2\/tasks\/[0-9a-f-]+\/(?:results|reports)\/[0-9a-f-]+\/report\.pdf\?/.test(reportPath)) {
            document.report.url = new URL(reportPath, base).href;
          }
          const evidencePath = document?.report?.evidence_download_path;
          if (typeof evidencePath === 'string' && /^\/v2\/tasks\/[0-9a-f-]+\/reports\/[0-9a-f-]+\/evidence\.zip\?/.test(evidencePath)) {
            document.report.evidence_url = new URL(evidencePath, base).href;
          }
        }
}
