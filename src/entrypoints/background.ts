import { OpenExportMessage } from '../shared/messages';

// Opens the export page; nothing else. No export state lives here (PRD §5.1).
export default defineBackground(() => {
	browser.runtime.onMessage.addListener((message: unknown) => {
		const parsed = OpenExportMessage.safeParse(message);
		if (!parsed.success) return;
		const query = parsed.data.source ? `?source=${parsed.data.source}` : '';
		void browser.tabs.create({ url: browser.runtime.getURL('/export.html') + query });
	});
});
