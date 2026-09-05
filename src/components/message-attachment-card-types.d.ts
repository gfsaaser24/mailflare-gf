import type { MessageAttachment } from "@/app/(dashboard)/(mail)/inbox/[messageId]/types";
import type { LucideIcon } from "lucide-react";

export interface MessageAttachmentCardProps {
	attachment: MessageAttachment;
	messageId: string;
	onPreview: (attachment: MessageAttachment) => void;
}

export type AttachmentVisual = {
	icon: LucideIcon;
	iconClassName: string;
	label: string;
	thumbnail: "image" | "video" | null;
};
