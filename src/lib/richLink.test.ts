import { describe, expect, it } from "vitest";
import { attachRichLink, isPayloadAttachment, parseRichLink } from "./richLink";

const LISTING = "https://www.hemnet.se/salda/lagenhet-4rum-vastmannagatan-44";

// payload_data of a URL balloon as BlueBubbles serves it: the bplist parsed to
// JSON, one top-level NSKeyedArchiver with UID references into $objects.
function urlBalloonArchive() {
  return [
    {
      $version: 100000,
      $archiver: "NSKeyedArchiver",
      $top: { root: { UID: 1 } },
      $objects: [
        "$null",
        { $class: { UID: 20 }, richLinkMetadata: { UID: 2 }, richLinkIsPlaceholder: false },
        {
          $class: { UID: 21 },
          title: { UID: 3 },
          summary: { UID: 4 },
          siteName: { UID: 5 },
          URL: { UID: 6 },
          originalURL: { UID: 8 },
          image: { UID: 10 },
          icon: { UID: 11 },
          imageMetadata: { UID: 12 },
        },
        "Lägenhet  4 rum\n Vasastan",
        "Såld 2024",
        "Hemnet",
        { $class: { UID: 22 }, "NS.base": { UID: 0 }, "NS.relative": { UID: 7 } },
        LISTING,
        { $class: { UID: 22 }, "NS.base": { UID: 0 }, "NS.relative": { UID: 9 } },
        `${LISTING}?utm_source=ios_app`,
        { $class: { UID: 23 }, richLinkImageAttachmentSubstituteIndex: 1, MIMEType: { UID: 14 } },
        { $class: { UID: 23 }, richLinkImageAttachmentSubstituteIndex: 0, MIMEType: { UID: 15 } },
        { $class: { UID: 24 }, URL: { UID: 13 }, size: "{1200, 630}" },
        { $class: { UID: 22 }, "NS.base": { UID: 0 }, "NS.relative": { UID: 16 } },
        "image/jpeg",
        "image/png",
        "https://bilder.hemnet.se/images/itemgallery_cut/ab/cd/abcd.jpg",
      ],
    },
  ];
}

describe("parseRichLink", () => {
  it("decodes LPLinkMetadata from a keyed archive", () => {
    expect(parseRichLink(urlBalloonArchive())).toEqual({
      url: LISTING,
      title: "Lägenhet 4 rum Vasastan",
      summary: "Såld 2024",
      siteName: "Hemnet",
      imageIndex: 1,
      iconIndex: 0,
      imageUrl: "https://bilder.hemnet.se/images/itemgallery_cut/ab/cd/abcd.jpg",
    });
  });

  it("accepts the archive as a JSON string or a bare object", () => {
    const archive = urlBalloonArchive();
    expect(parseRichLink(JSON.stringify(archive))?.title).toBe("Lägenhet 4 rum Vasastan");
    expect(parseRichLink(archive[0])?.siteName).toBe("Hemnet");
  });

  it("accepts an already-decoded payload", () => {
    const link = parseRichLink({
      richLinkMetadata: {
        URL: "https://example.com/a",
        title: "Example",
        images: [{ richLinkImageAttachmentSubstituteIndex: 2 }],
      },
    });
    expect(link).toEqual({ url: "https://example.com/a", title: "Example", summary: "", siteName: "", imageIndex: 2 });
  });

  it("falls back to originalURL", () => {
    const link = parseRichLink({ originalURL: "https://example.com/b", title: "B" });
    expect(link?.url).toBe("https://example.com/b");
  });

  it("ignores payloads that are not rich links", () => {
    expect(parseRichLink(null)).toBeUndefined();
    expect(parseRichLink("not json")).toBeUndefined();
    expect(parseRichLink([{ $objects: ["$null", { appName: "Game Pigeon" }], $top: { root: { UID: 1 } } }])).toBeUndefined();
    // Metadata with nothing to show.
    expect(parseRichLink({ URL: "https://example.com/", title: "" })).toBeUndefined();
  });

  it("survives a cyclic archive", () => {
    const archive = {
      $top: { root: { UID: 1 } },
      $objects: ["$null", { self: { UID: 1 }, URL: { UID: 2 }, title: { UID: 3 } }, "https://e.com/", "T"],
    };
    expect(parseRichLink(archive)?.title).toBe("T");
  });

  it("drops a non-web image address", () => {
    const link = parseRichLink({ URL: "https://e.com/", title: "T", imageMetadata: { URL: "file:///x.jpg" } });
    expect(link?.imageUrl).toBeUndefined();
  });
});

describe("attachRichLink", () => {
  it("replaces payloadData with the decoded link", () => {
    const raw: Record<string, unknown> = { guid: "m", payloadData: urlBalloonArchive() };
    attachRichLink(raw);
    expect(raw.payloadData).toBeUndefined();
    expect((raw.richLink as { siteName: string }).siteName).toBe("Hemnet");
  });

  it("leaves messages without payloadData alone", () => {
    const raw: { guid: string; richLink?: undefined } = { guid: "m" };
    expect(attachRichLink(raw)).toEqual({ guid: "m" });
  });
});

describe("isPayloadAttachment", () => {
  it("matches the balloon's payload files only", () => {
    const att = (transferName: string) => ({ guid: "g", mimeType: "", transferName, url: "" });
    expect(isPayloadAttachment(att("6700A7EB-02B4-45F2-BCE1-DF8ED69819AC.pluginPayloadAttachment"))).toBe(true);
    expect(isPayloadAttachment(att("IMG_0001.HEIC"))).toBe(false);
  });
});
