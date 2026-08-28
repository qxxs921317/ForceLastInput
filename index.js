import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

// ⚠️ 다른 확장(예: Aggressive Notepad / cherry-note-extension)과 절대 겹치지 않도록
// 이 확장 전용 네임스페이스만 사용합니다. (설정 키 / DOM id 모두 fli- 접두사)
const EXT_NAME = "force-last-input";
const BTN_ID = "fli-toggle-btn";
const ICON_ID = "fli-toggle-icon";

const DEFAULT_CONFIG = {
    enabled: false,
    onEmoji: "🔵",
    offEmoji: "🔴",
};

let lastUserText = ""; // 가장 최근에 "전송"된 유저 메시지 원문
const WRAP_TAG = "User's Input"; // AI가 안 헷갈리게 감싸는 태그명

// ---------- 설정 헬퍼 ----------

function getConfig() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = {};
    }
    extension_settings[EXT_NAME] = { ...DEFAULT_CONFIG, ...extension_settings[EXT_NAME] };
    return extension_settings[EXT_NAME];
}

function saveConfig() {
    saveSettingsDebounced();
}

// ---------- 최근 전송된 유저 메시지 캡처 ----------
// MESSAGE_SENT는 유저 메시지가 채팅 배열에 실제로 추가된 직후 발생하므로,
// 여기서 그 시점의 최종 텍스트를 그대로 가져옵니다 (impersonate 등으로 텍스트가
// 바뀌는 경우까지 정확히 반영됨).

function captureLastUserMessage() {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!Array.isArray(chat) || chat.length === 0) return;
        const last = chat[chat.length - 1];
        if (last && last.is_user) {
            lastUserText = (last.mes || "").trim();
        }
    } catch (e) {
        console.error("[Force Last Input] 유저 메시지 캡처 실패:", e);
    }
}

// ---------- 프롬프트 맨 끝으로 강제 재배치 ----------

function isForceEnabled() {
    return !!getConfig().enabled && !!lastUserText;
}

function wrapUserInput(text) {
    return `<${WRAP_TAG}>\n${text}\n</${WRAP_TAG}>`;
}

// Chat Completion (Gemini/Vertex, Claude API, OpenAI 등)
function onChatCompletionPromptReady(eventData) {
    try {
        if (!eventData || eventData.dryRun) return;
        if (!isForceEnabled()) return;
        if (!Array.isArray(eventData.chat)) return;

        const chat = eventData.chat;

        // 배열 안에서 "가장 마지막에 등장하는" 동일 텍스트의 user 메시지를 찾아 제거하고
        // (다른 확장이 이미 맨 끝에 뭔가를 붙여놨어도 상관없이) 배열의 진짜 맨 끝으로 다시 push.
        let removeIndex = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const entry = chat[i];
            if (entry && entry.role === "user" && typeof entry.content === "string" && entry.content.trim() === lastUserText) {
                removeIndex = i;
                break;
            }
        }

        if (removeIndex !== -1) {
            chat.splice(removeIndex, 1);
        }

        const payload = wrapUserInput(lastUserText);
        chat.push({ role: "user", content: payload });
        console.log(`[Force Last Input] chat-completion 맨 끝으로 강제 재배치됨 (len=${payload.length})`);
    } catch (e) {
        console.error("[Force Last Input] chat-completion 재배치 실패:", e);
    }
}

// Text Completion (KoboldAI, 로컬 모델 등)
function onTextCompletionPromptReady(eventData) {
    try {
        if (!eventData) return;
        if (!isForceEnabled()) return;
        if (typeof eventData.prompt !== "string") return;

        // 문자열 프롬프트는 정확한 위치 splice가 불가능하므로,
        // 원문이 이미 포함돼 있어도 강조용으로 맨 끝에 한 번 더 붙여 절대 안 밀리게 함.
        const payload = wrapUserInput(lastUserText);
        eventData.prompt = `${eventData.prompt}\n${payload}\n`;
        console.log(`[Force Last Input] text-completion 맨 끝에 강제 삽입됨 (len=${payload.length})`);
    } catch (e) {
        console.error("[Force Last Input] text-completion 재배치 실패:", e);
    }
}

function registerHooks() {
    eventSource.on(event_types.MESSAGE_SENT, captureLastUserMessage);

    if (event_types.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    } else {
        console.warn("[Force Last Input] CHAT_COMPLETION_PROMPT_READY 이벤트를 찾을 수 없음");
    }

    const textEventName = event_types.GENERATE_AFTER_COMBINE_PROMPTS
        || event_types.TEXT_COMPLETION_PROMPT_READY
        || event_types.GENERATE_AFTER_DATA;

    if (textEventName) {
        eventSource.on(textEventName, onTextCompletionPromptReady);
    } else {
        console.warn("[Force Last Input] Text Completion용 이벤트를 찾지 못함");
    }
}

// ---------- 툴바 토글 버튼 ----------

function applyButtonIcon() {
    const config = getConfig();
    $(`#${ICON_ID}`).text(config.enabled ? config.onEmoji : config.offEmoji);
    $(`#${BTN_ID}`)
        .attr("title", config.enabled ? "입력 강제 최하단 삽입: 켜짐" : "입력 강제 최하단 삽입: 꺼짐")
        .toggleClass("fli-active", config.enabled);
}

function buildToggleButton() {
    if ($(`#${BTN_ID}`).length) return; // 중복 삽입 방지

    const html = `<div id="${BTN_ID}" class="interactable" tabindex="0"><span id="${ICON_ID}"></span></div>`;

    const $rightSendForm = $("#rightSendForm");
    if ($rightSendForm.length && $("#send_but").length) {
        $("#send_but").before(html);
    } else {
        // 못 찾으면 잠시 후 재시도 (테마/확장 로딩 순서 이슈 대비)
        setTimeout(buildToggleButton, 500);
        return;
    }

    $(`#${BTN_ID}`).on("click", () => {
        const config = getConfig();
        config.enabled = !config.enabled;
        saveConfig();
        applyButtonIcon();
    });

    applyButtonIcon();
}

// ---------- 확장 설정 패널 (이모지 커스터마이즈) ----------

function buildSettingsPanel() {
    const config = getConfig();

    const html = `
    <div class="fli-settings-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🔵 Force Last Input</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="fli-on-emoji-input">켜짐(ON) 아이콘</label>
                <input id="fli-on-emoji-input" class="text_pole" type="text" maxlength="4" value="${config.onEmoji}">

                <label for="fli-off-emoji-input">꺼짐(OFF) 아이콘</label>
                <input id="fli-off-emoji-input" class="text_pole" type="text" maxlength="4" value="${config.offEmoji}">

                <small>💡 보내는 메시지가 맨 밑에 강제로 들어가서 AI가 절대 놓치지 않게 하는 기능이에요. 버튼은 전송 버튼 옆에 있어요.</small>
            </div>
        </div>
    </div>
    `;

    const $target = $("#extensions_settings2").length ? $("#extensions_settings2") : $("#extensions_settings");
    $target.append(html);

    $("#fli-on-emoji-input").on("input", function () {
        const val = $(this).val().trim() || DEFAULT_CONFIG.onEmoji;
        getConfig().onEmoji = val;
        saveConfig();
        applyButtonIcon();
    });

    $("#fli-off-emoji-input").on("input", function () {
        const val = $(this).val().trim() || DEFAULT_CONFIG.offEmoji;
        getConfig().offEmoji = val;
        saveConfig();
        applyButtonIcon();
    });
}

// ---------- 초기화 ----------

jQuery(async () => {
    buildToggleButton();
    buildSettingsPanel();
    registerHooks();
});
