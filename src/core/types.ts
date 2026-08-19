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
  supersedes?: string;
  slug?: string;
  mentionRoleIds?: string[];
}

export interface Announcement extends AnnouncementInput {
  id: string;
  revision: number;
  slug: string;
  status: 'draft' | 'publish_requested' | 'scheduled' | 'published' | 'superseded' | 'discarded';
  createdBy: string;
  publishRequestedBy?: string;
  publishConfirmedBy?: string;
  publishedAt?: string;
  publishRejectedBy?: string;
  publishRejectedReason?: string;
  /** When a scheduled announcement is due, ISO-8601 UTC. Set only while status is 'scheduled'. */
  scheduledFor?: string;
}

export interface DiscordRole {
  name: string;
  id: string;
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
