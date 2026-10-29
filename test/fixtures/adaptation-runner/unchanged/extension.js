// Synthetic extension bundle for the adaptation tests.
//
// It carries exactly the two shapes the probe is expected to find here and nothing else: the
// channel initialisation hook and the panel attachment. Both are written the way the shipped
// bundle writes them — minified spacing matters, the probe matches them structurally.
class ChannelRegistry {
    channelInitialized(channel){
        const entry = this.channels.get(channel);
        if (!entry) return;
    }
}

function attachPanel(panel, icon) {
    panel.iconPath={light:icon,dark:icon},panel.webview.options={enableScripts:!0};
    return panel;
}

module.exports = { ChannelRegistry, attachPanel };
