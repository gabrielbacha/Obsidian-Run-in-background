import { describe, expect, it } from "vitest";
import { ABOUT_AND_FEEDBACK, BUG_REPORT_URL, FEATURE_REQUEST_URL, MORE_PLUGINS_URL, WEBSITE_URL } from "../src/external-links";

describe("external links", () => {
  it("uses the exact visible labels and copy", () => {
    expect(ABOUT_AND_FEEDBACK).toEqual({
      heading: "About and feedback",
      name: "Run in Background by Gabriel Bacha",
      description: "Explore more software, tools, and ideas at gabrielbacha.com.",
      websiteLabel: "Visit website",
      morePluginsLabel: "More plugins",
      featureRequestLabel: "Request a feature",
      bugReportLabel: "Report a bug",
    });
  });

  it("uses the exact tracked website destination", () => {
    expect(WEBSITE_URL).toBe("https://www.gabrielbacha.com/?utm_source=obsidian_app&utm_medium=referral&utm_campaign=obsidian_assets&utm_content=run_in_background_settings");
  });

  it("uses preselected GitHub issue forms", () => {
    expect(FEATURE_REQUEST_URL).toBe("https://github.com/gabrielbacha/Obsidian-Run-in-background/issues/new?template=feature_request.yml");
    expect(MORE_PLUGINS_URL).toBe("https://obsidian.md/plugins?search=Gabriel%20Bacha");
    expect(BUG_REPORT_URL).toBe("https://github.com/gabrielbacha/Obsidian-Run-in-background/issues/new?template=bug_report.yml");
  });
});
