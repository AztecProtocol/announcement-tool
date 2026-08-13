export type AnnouncementType = 'upgrade' | 'governance' | 'info';

export type Severity = 'critical' | 'recommended' | 'info';

export type Network = 'mainnet' | 'testnet';

export type Audience = 'operators' | 'ecosystem';

export type DeliveryKind = 'publish' | 'update' | 'reminder';

export interface ActionRequired {
  action: string;
  deadline?: string;
  applies_to: string[];
}

export interface Link {
  label: string;
  url: string;
}

export interface AnnouncementInput {
  type: AnnouncementType;
  networks: Network[];
  audiences: Audience[];
  severity: Severity;
  title: string;
  bodyMd: string;
  actionsRequired: ActionRequired[];
  links: Link[];
  expiresAt?: string;
  supersedes?: string;
}

export interface Announcement extends AnnouncementInput {
  id: string;
  revision: number;
  slug: string;
  status: 'draft' | 'publish_requested' | 'published' | 'superseded';
  createdBy: string;
  publishRequestedBy?: string;
  publishConfirmedBy?: string;
  publishedAt?: string;
}

export interface DeliveryTarget {
  channel: string;
  target: string;
}

export interface Template {
  id: string;
  name: string;
  input: AnnouncementInput;
  createdBy: string;
  createdAt: string;
}
