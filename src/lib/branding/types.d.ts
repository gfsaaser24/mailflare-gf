export type Branding = {
	appName: string;
	hasCustomIcon: boolean;
	/** Self-hosted build: branding customization is always available. Kept for API payload compatibility. */
	canCustomizeBranding: boolean;
};
