// Synthetic webview bundle for the adaptation tests.
//
// It carries exactly the two shapes the probe is expected to find here and nothing else: the
// composer model pill and the login form. Minified spacing and quoting match the shipped bundle,
// because the probe matches these shapes structurally rather than by description.
const menu = { isOpen: false };
const session = { logEvent() {} };
const stockLabel = 'gpt-6.1-sol[1m]';
const effortLevel = 'Extra high';

function renderComposer() {
    let props={label:stockLabel,effort:effortLevel,isOpen:menu.isOpen,onToggle:()=>{session.logEvent("model_pill_clicked",{opened:!0})}};
    return props;
}

class LoginView {
    showLogin(){this.forceLogin.value=!0}
}

module.exports = { renderComposer, LoginView };
