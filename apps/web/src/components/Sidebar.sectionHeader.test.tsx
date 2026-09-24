import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarSectionHeader } from "./Sidebar";

const RULE = 'class="h-px';

describe("SidebarSectionHeader", () => {
  it("draws a section header at medium weight with a trailing rule", () => {
    const html = renderToStaticMarkup(<SidebarSectionHeader label="Pinned" />);

    expect(html).toContain("font-medium");
    expect(html).toContain(RULE);
  });

  it("draws a sub-level header lighter and without the rule", () => {
    const html = renderToStaticMarkup(<SidebarSectionHeader level="sub" label="Chats" />);

    expect(html).toContain("font-normal");
    expect(html).not.toContain("font-medium");
    expect(html).not.toContain(RULE);
  });

  it("drops the rule on an icon header and lets its detail truncate before the label", () => {
    const html = renderToStaticMarkup(
      <SidebarSectionHeader
        icon={<span data-icon />}
        label="orchard"
        detail="1 master · 4 cards · 1 chat"
        toggle={{ expanded: true, onToggle: () => {} }}
      />,
    );

    expect(html).not.toContain(RULE);
    expect(html).toContain('class="font-normal min-w-0 flex-1 truncate">1 master');
  });
});
