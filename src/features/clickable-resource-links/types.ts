export const OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE =
  "feature.clickable-resource-links.openExternal" as const;

export const SUPPORTED_EXTERNAL_PROTOCOLS = ["http:", "https:"] as const;

export type SupportedExternalProtocol =
  (typeof SUPPORTED_EXTERNAL_PROTOCOLS)[number];

export type ResourceLinkKind = "file" | "web";

export interface DetectedResourceLink {
  kind: ResourceLinkKind;
  text: string;
  href: string;
  start: number;
  end: number;
  lineRangeText?: string;
}

export interface OpenExternalResourceLinkMessage {
  type: typeof OPEN_EXTERNAL_RESOURCE_LINK_MESSAGE_TYPE;
  url: string;
}
