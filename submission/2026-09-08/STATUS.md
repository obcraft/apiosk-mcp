# OpenAI submission status — 2026-09-08

Draft: Apiosk Production
https://platform.openai.com/plugins/edit/asdk_app_6a9c84a5fba4819186c8425bdb258772/asdk_app_v_6a9c84a769b8819182861ede11f05108

Saved: version 1.8.0; current v2 description; three starter prompts; five positive and three negative reviewer test scenarios; release notes; explanations for all five v2 tools. Existing Global setting is Allow all.

Uploaded: ../../dist/apiosk-skill-1.8.0-gateway-v2-20260908.zip. Contains only apiosk/SKILL.md and apiosk/agents/openai.yaml. ZIP integrity and skill validator passed. OpenAI scanning is still pending, with a portal estimate of up to two hours. No independent installed-skill behavioral test has been completed for this new bundle.

Existing demo URL returns HTTP 200 video/mp4:
https://api.apiosk.com/storage/v1/object/public/media/Apiosk-Connect-OAuth-Chat-Payment.mp4

Not submitted. Required commerce attestation says the plugin must not facilitate purchases of digital goods, services or subscriptions. The actual product charges for digital API execution, which is truthfully disclosed in the form. Do not tick a false statement. Terms and compliance attestations remain unchecked.

Reviewer credentials are empty. Supply a dedicated funded, capped demo account in the portal, without MFA, email-code or private-network requirements. Do not use a real user account. The supplied scenarios are reviewer instructions, not a claim that all tests passed on a dedicated account.

MCP scan imports five current v2 tools, but the portal has continued to flag its scan requirement. Verify terminal scan status before review.

The production apiosk_execute metadata reports destructiveHint false although it can create irreversible paid charges. Its draft justification explicitly marks the correction required. Correct source metadata, validate and deploy, rescan, then replace the temporary correction note with the accurate true justification before submission.

Unrelated concurrent changes exist in mcp/src and mcp/test; none were modified or committed in this submission pass.
