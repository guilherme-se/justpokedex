// ==UserScript==
// @name         JustPokedex
// @namespace    poke-idle-world-tools
// @version      3.0
// @description  Lê os dados dos Pokémon e estima seus IVs individuais
// @match        https://poke.idleworld.online/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    // -------------------------------------------------------------------------
    // RASTREAMENTO GLOBAL DE WEBSOCKET & MERCADO GLOBAL
    // -------------------------------------------------------------------------
    const NativeWebSocket = window.WebSocket;
    let gameSocket = null;
    let latestInventory = null;
    let latestPokemon = null;
    let latestMarketData = null;
    let latestMyListingsData = null;
    let latestHistoryData = null;
    const gameEventWaiters = new Map();

    function handleGameSocketMessage(event) {
        let message;
        try {
            message = typeof event.data === "string" ? JSON.parse(event.data) : null;
        } catch (e) {
            return;
        }
        if (!message) return;

        if (message.type === "inventory") latestInventory = message.items || [];
        if (message.type === "pokes") latestPokemon = message.list || [];
        if (message.type === "market" || message.type === "market-list" || message.type === "mkt" || message.listings || message.mine) {
            if (message.listings) latestMarketData = message.listings;
            if (message.mine) latestMyListingsData = message.mine;
            if (message.history) latestHistoryData = message.history;
        }
        if (message.mine) latestMyListingsData = message.mine;
        if (message.history) latestHistoryData = message.history;

        const waiters = gameEventWaiters.get(message.type);
        if (waiters) {
            gameEventWaiters.delete(message.type);
            waiters.forEach(resolve => resolve(message));
        }
    }

    function TrackedWebSocket(url, protocols) {
        const socket = protocols === undefined
            ? new NativeWebSocket(url)
            : new NativeWebSocket(url, protocols);
        if (String(url).startsWith("ws:") || String(url).startsWith("wss:") || String(url).includes("token=") || String(url).includes("ws")) {
            gameSocket = socket;
            socket.addEventListener("message", handleGameSocketMessage);
            socket.addEventListener("close", () => {
                if (gameSocket === socket) gameSocket = null;
            });
        }
        return socket;
    }
    if (NativeWebSocket) {
        TrackedWebSocket.prototype = NativeWebSocket.prototype;
        Object.setPrototypeOf(TrackedWebSocket, NativeWebSocket);
        window.WebSocket = TrackedWebSocket;
    }

    function getGameTokens() {
        try {
            return JSON.parse(sessionStorage.getItem("pokeweb:tokens") || "null");
        } catch (e) {
            return null;
        }
    }

    async function refreshGameAccessToken() {
        const tokens = getGameTokens();
        if (!tokens?.refreshToken) return null;
        try {
            const response = await fetch("/api/auth/refresh", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refreshToken: tokens.refreshToken })
            });
            if (!response.ok) return null;
            const refreshed = await response.json();
            if (!refreshed?.accessToken) return null;
            sessionStorage.setItem("pokeweb:tokens", JSON.stringify(refreshed));
            return refreshed.accessToken;
        } catch (e) {
            return null;
        }
    }

    async function gameApiRequest(endpoint, options = {}) {
        const send = accessToken => fetch(endpoint, {
            ...options,
            headers: {
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                ...(options.headers || {})
            }
        });

        let response = await send(getGameTokens()?.accessToken);
        if (response.status === 401) {
            const refreshedToken = await refreshGameAccessToken();
            if (refreshedToken) response = await send(refreshedToken);
        }

        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result?.message || result?.error || `HTTP ${response.status}`);
        return result;
    }

    const CONFIG = {
        tooltipSelector: ".inv-tip",
        panelId: "pokemon-reader-panel",
        storageKey: "pokemon-reader-panel-state",

        maxIVIndividual: 32,
        maxIVTotal: 192,
        qualidadeMaxima: 1.80,

        expoentes: {
            hp: 0.95,
            atk: 0.80,
            def: 0.80,
            spa: 0.80,
            spd: 0.80,
            vel: 0.95
        }
    };

    const SHINY_COUNTER_KEY = "justpokedex-shiny-counter";
    const SHINY_SOUND_ENABLED_KEY = "justpokedex-shiny-sound-enabled";
    let contadorShinies = 0;
    let shinyDetectadoNoMapa = false;
    let tempoUltimoShiny = 0;
    let tempoUltimoIncrementoShiny = 0;
    let tempoSilenciarShiny = 0;
    let tempoUltimoPacoteShiny = 0;

    // Rastreamento inteligente de Shinies no mapa (evita duplicações de notificação/contador)
    const shiniesVistosNoMapa = new Map(); // mobKey => { firstSeen, lastSeen, speciesId, slot }
    const shiniesProcessadosEDerrotados = new Set(); // mobKey

    let shinyDetectorEnabled = true;
    let dailyGiftEnabled = true;
    let shinySoundEnabled = true;

    try {
        const salvoCount = localStorage.getItem(SHINY_COUNTER_KEY);
        if (salvoCount) {
            contadorShinies = parseInt(salvoCount, 10) || 0;
        }
        const shinySalvo = localStorage.getItem("justpokedex-shiny-enabled");
        if (shinySalvo !== null) {
            shinyDetectorEnabled = shinySalvo === "true";
        }
        const dailySalvo = localStorage.getItem("justpokedex-daily-enabled");
        if (dailySalvo !== null) {
            dailyGiftEnabled = dailySalvo === "true";
        }
        const soundSalvo = localStorage.getItem(SHINY_SOUND_ENABLED_KEY);
        if (soundSalvo !== null) {
            shinySoundEnabled = soundSalvo === "true";
        }
    } catch (e) { }

    function atualizarBotoesTopBanners() {
        const btnShiny = document.getElementById("toggle-shiny");
        const btnDaily = document.getElementById("toggle-daily");
        const gridBanners = document.querySelector(".top-banners-grid");
        const bannerShiny = document.getElementById("shiny-detector-banner");
        const bannerDaily = document.getElementById("daily-gift-banner");

        if (btnShiny) {
            btnShiny.style.opacity = shinyDetectorEnabled ? "1" : "0.4";
            btnShiny.title = shinyDetectorEnabled ? "Detector de Shiny: ATIVADO (Clique para Ocultar/Desativar)" : "Detector de Shiny: DESATIVADO (Clique para Exibir/Ativar)";
        }

        if (btnDaily) {
            btnDaily.style.opacity = dailyGiftEnabled ? "1" : "0.4";
            btnDaily.title = dailyGiftEnabled ? "Resgate Diário: ATIVADO (Clique para Ocultar/Desativar)" : "Resgate Diário: DESATIVADO (Clique para Exibir/Ativar)";
        }

        if (bannerShiny) {
            bannerShiny.style.display = shinyDetectorEnabled ? "flex" : "none";
        }
        if (bannerDaily) {
            bannerDaily.style.display = dailyGiftEnabled ? "flex" : "none";
        }

        if (gridBanners) {
            if (shinyDetectorEnabled && dailyGiftEnabled) {
                gridBanners.style.display = "grid";
                gridBanners.style.gridTemplateColumns = "1fr 1fr";
                if (bannerShiny) bannerShiny.style.borderRight = "1px solid rgba(255,255,255,0.08)";
            } else if (shinyDetectorEnabled || dailyGiftEnabled) {
                gridBanners.style.display = "grid";
                gridBanners.style.gridTemplateColumns = "1fr";
                if (bannerShiny) bannerShiny.style.borderRight = "none";
            } else {
                gridBanners.style.display = "none";
            }
        }
    }

    function incrementarContadorShiny(forcar = false) {
        const agora = Date.now();
        // Incrementa quando for uma nova detecção única de Shiny no mapa
        if (forcar || (agora - tempoUltimoIncrementoShiny > 1000)) {
            contadorShinies++;
            tempoUltimoIncrementoShiny = agora;
            try {
                localStorage.setItem(SHINY_COUNTER_KEY, String(contadorShinies));
            } catch (e) { }
            if (typeof atualizarBannerDetectorShiny === "function") {
                atualizarBannerDetectorShiny();
            }
        }
    }

    function zerarContadorShiny() {
        contadorShinies = 0;
        shiniesVistosNoMapa.clear();
        shiniesProcessadosEDerrotados.clear();
        try {
            localStorage.setItem(SHINY_COUNTER_KEY, "0");
        } catch (e) { }
        atualizarBannerDetectorShiny();
    }

    let tempoUltimoSomShiny = 0;
    const SHINY_SOUND_URL = "https://www.myinstants.com/media/sounds/legends-arceus-shiny-noise.mp3";

    function tocarSomShiny(forcar = false) {
        if (!shinySoundEnabled && !forcar) {
            return;
        }
        const agora = Date.now();
        // Cooldown de 3 segundos para evitar sobreposição de áudios repetidos
        if (!forcar && (agora - tempoUltimoSomShiny < 3000)) {
            return;
        }
        tempoUltimoSomShiny = agora;

        try {
            const audioObj = new Audio(SHINY_SOUND_URL);
            audioObj.loop = false;
            audioObj.volume = 0.85;
            audioObj.play().catch(e => {
                console.warn("[JustPokédex] Não foi possível tocar o áudio de Shiny:", e);
            });
        } catch (e) { }
    }

    function toggleSomShiny() {
        shinySoundEnabled = !shinySoundEnabled;
        try {
            localStorage.setItem(SHINY_SOUND_ENABLED_KEY, String(shinySoundEnabled));
        } catch (e) { }
        if (shinySoundEnabled) {
            tocarSomShiny(true);
        }
        atualizarBannerDetectorShiny();
    }

    function dispensarAlertaShiny() {
        shinyDetectadoNoMapa = false;
        tempoSilenciarShiny = Date.now() + 60000;
        if (typeof atualizarBannerDetectorShiny === "function") {
            atualizarBannerDetectorShiny();
        }
    }

    (function monitorarInatividadeShiny() {
        setInterval(() => {
            const agora = Date.now();
            if (tempoUltimoPacoteShiny > 0 && (agora - tempoUltimoPacoteShiny > 4000)) {
                tempoSilenciarShiny = 0;
                if (shiniesVistosNoMapa.size === 0 && shinyDetectadoNoMapa && (agora - tempoUltimoShiny > 6000)) {
                    shinyDetectadoNoMapa = false;
                    if (typeof atualizarBannerDetectorShiny === "function") {
                        atualizarBannerDetectorShiny();
                    }
                }
            }
        }, 2000);
    })();

    // Diagnóstico e estatísticas da conexão WebSocket
    const wsStats = {
        intercepted: false,
        socketCount: 0,
        receivedMessagesCount: 0,
        catchResultCount: 0,
        fieldCount: 0,
        analyzerCount: 0,
        lastError: null,
        lastMessageTime: null,
        lastCatchResultTime: null
    };

    // Interceptador Centralizado de WebSocket e Barramento de Eventos Internos
    function processarEMitirMensagemWS(data) {
        if (!data) return;

        wsStats.lastMessageTime = Date.now();
        wsStats.receivedMessagesCount++;

        function emitir(parsed) {
            if (!parsed) return;

            // 1. Evento genérico oficial da extensão
            try {
                window.dispatchEvent(
                    new CustomEvent("justpokedex-ws-message", {
                        detail: parsed
                    })
                );
            } catch (e) { }

            // 2. Evento legado para retrocompatibilidade
            try {
                window.dispatchEvent(
                    new CustomEvent("pokemon-extension-ws-message", {
                        detail: parsed
                    })
                );
            } catch (e) { }

            // 3. Processamento direto seguro no analisador de captura
            try {
                if (typeof processarMensagemCatchAnalyzer === "function") {
                    processarMensagemCatchAnalyzer(parsed);
                }
            } catch (e) {
                wsStats.lastError = e ? String(e.message || e) : "Erro ao processar mensagem";
            }

            // 4. Cache e resolvedores para requisições de Lojas/Depot (Funcionalidades 3 e 4)
            try {
                if (parsed.type === "inventory") latestInventory = parsed.items || [];
                if (parsed.type === "pokes") latestPokemon = parsed.list || [];
                if (typeof gameEventWaiters !== "undefined" && gameEventWaiters.has(parsed.type)) {
                    const waiters = gameEventWaiters.get(parsed.type);
                    gameEventWaiters.delete(parsed.type);
                    waiters.forEach(resolve => resolve(parsed));
                }
            } catch (e) { }
        }

        if (typeof data === "string") {
            try {
                const parsed = JSON.parse(data);
                emitir(parsed);
            } catch (e) {
                // Extrai objetos JSON embutidos caso venha envelopado ou concatenado
                try {
                    const matches = data.match(/\{.*?\}/g);
                    if (matches) {
                        matches.forEach(str => {
                            try {
                                const p = JSON.parse(str);
                                emitir(p);
                            } catch (err) { }
                        });
                    }
                } catch (e2) { }
            }
        } else if (data instanceof ArrayBuffer || (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data))) {
            try {
                const decoder = new TextDecoder("utf-8");
                const buffer = data.buffer ? data.buffer : data;
                const str = decoder.decode(buffer);
                const parsed = JSON.parse(str);
                emitir(parsed);
            } catch (e) { }
        } else if (typeof Blob !== "undefined" && data instanceof Blob) {
            try {
                const reader = new FileReader();
                reader.onload = function () {
                    try {
                        const str = reader.result;
                        const parsed = JSON.parse(str);
                        emitir(parsed);
                    } catch (e) { }
                };
                reader.readAsText(data);
            } catch (e) { }
        } else if (typeof data === "object") {
            emitir(data);
        }
    }

    (function interceptarWebSocketCentral() {
        const eventosProcessados = new WeakSet();

        function processarSeguro(data, evento) {
            if (evento && evento.target && evento.target.readyState === WebSocket.OPEN) {
                gameSocket = evento.target;
            }
            if (evento && typeof evento === "object") {
                if (eventosProcessados.has(evento)) return;
                eventosProcessados.add(evento);
            }
            try {
                processarEMitirMensagemWS(data);
            } catch (e) { }
        }

        const listenerMap = new WeakMap();

        // 1. Hook em addEventListener / removeEventListener do WebSocket.prototype
        try {
            const origAddEventListener = WebSocket.prototype.addEventListener;
            const origRemoveEventListener = WebSocket.prototype.removeEventListener;

            if (origAddEventListener && !origAddEventListener.__justPokedexPatched) {
                WebSocket.prototype.addEventListener = function (type, listener, options) {
                    if (type === "message" && typeof listener === "function") {
                        let wrapped = listenerMap.get(listener);
                        if (!wrapped) {
                            wrapped = function (event) {
                                processarSeguro(event ? event.data : null, event);
                                return listener.apply(this, arguments);
                            };
                            listenerMap.set(listener, wrapped);
                        }
                        return origAddEventListener.call(this, type, wrapped, options);
                    }
                    return origAddEventListener.apply(this, arguments);
                };
                WebSocket.prototype.addEventListener.__justPokedexPatched = true;
            }

            if (origRemoveEventListener && !origRemoveEventListener.__justPokedexPatched) {
                WebSocket.prototype.removeEventListener = function (type, listener, options) {
                    if (type === "message" && typeof listener === "function") {
                        const wrapped = listenerMap.get(listener);
                        if (wrapped) {
                            return origRemoveEventListener.call(this, type, wrapped, options);
                        }
                    }
                    return origRemoveEventListener.apply(this, arguments);
                };
                WebSocket.prototype.removeEventListener.__justPokedexPatched = true;
            }
        } catch (e) { }

        // 2. Hook no setter de onmessage do WebSocket.prototype
        try {
            const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
            if (desc && desc.set && !desc.set.__justPokedexPatched) {
                const origSet = desc.set;
                const origGet = desc.get;
                Object.defineProperty(WebSocket.prototype, "onmessage", {
                    set(fn) {
                        if (typeof fn === "function") {
                            const wrapped = function (event) {
                                processarSeguro(event ? event.data : null, event);
                                return fn.apply(this, arguments);
                            };
                            wrapped.__justPokedexPatched = true;
                            return origSet.call(this, wrapped);
                        }
                        return origSet.call(this, fn);
                    },
                    get() {
                        return origGet ? origGet.call(this) : null;
                    },
                    configurable: true,
                    enumerable: true
                });
            }
        } catch (e) { }

        // 3. Constructor Proxy
        const OriginalWebSocket = window.WebSocket;
        if (OriginalWebSocket && !OriginalWebSocket.__isJustPokedexIntercepted) {
            function ProxyWebSocket(...args) {
                wsStats.socketCount++;
                wsStats.intercepted = true;
                const ws = new OriginalWebSocket(...args);

                ws.addEventListener("message", (evento) => {
                    processarSeguro(evento ? evento.data : null, evento);
                });

                return ws;
            }

            ProxyWebSocket.prototype = OriginalWebSocket.prototype;
            ProxyWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
            ProxyWebSocket.OPEN = OriginalWebSocket.OPEN;
            ProxyWebSocket.CLOSING = OriginalWebSocket.CLOSING;
            ProxyWebSocket.CLOSED = OriginalWebSocket.CLOSED;
            ProxyWebSocket.__isJustPokedexIntercepted = true;

            window.WebSocket = ProxyWebSocket;
            wsStats.intercepted = true;
        }
    })();

    function extrairMobsDoPacote(obj, depth = 0, lista = []) {
        if (!obj || typeof obj !== "object" || depth > 5) return lista;

        if (obj.shiny !== undefined || obj.isShiny !== undefined || (obj.row !== undefined && obj.col !== undefined && obj.hp !== undefined)) {
            lista.push(obj);
        }

        if (Array.isArray(obj)) {
            obj.forEach(item => extrairMobsDoPacote(item, depth + 1, lista));
        } else {
            if (Array.isArray(obj.mobs)) {
                obj.mobs.forEach(item => extrairMobsDoPacote(item, depth + 1, lista));
            }
            for (const k in obj) {
                if (k === "mobs") continue;
                const val = obj[k];
                if (val && typeof val === "object" && depth < 3) {
                    if (!Array.isArray(val) || k === "entities" || k === "monsters" || k === "pokemons") {
                        extrairMobsDoPacote(val, depth + 1, lista);
                    }
                }
            }
        }
        return lista;
    }

    function analisarShiniesNoPacote(parsed) {
        if (!parsed || typeof parsed !== "object") return;

        const agora = Date.now();
        const mobs = extrairMobsDoPacote(parsed);

        const shiniesVivosPacote = [];
        const shiniesMortosPacote = [];

        for (const mob of mobs) {
            const isShiny = mob.shiny === true || mob.isShiny === true || mob.shiny_state === true;
            if (!isShiny) continue;

            const isDead = Boolean(mob.dead || mob.isDead || mob.killed);
            const isRespawning = Boolean(mob.respawning || mob.isRespawning);
            const hpZero = mob.hp !== undefined && mob.hp !== null && Number(mob.hp) === 0;

            const mobKey = (mob.id !== undefined && mob.id !== null)
                ? `id_${mob.id}`
                : (mob.slot !== undefined && mob.slot !== null)
                    ? `slot_${mob.slot}_sp_${mob.speciesId || mob.species || 'x'}`
                    : `pos_${mob.row}_${mob.col}_sp_${mob.speciesId || mob.species || 'x'}`;

            if (isDead || isRespawning || hpZero) {
                shiniesMortosPacote.push(mobKey);
            } else {
                shiniesVivosPacote.push({ mobKey, mob });
            }
        }

        for (const deadKey of shiniesMortosPacote) {
            shiniesVistosNoMapa.delete(deadKey);
            shiniesProcessadosEDerrotados.add(deadKey);
        }

        let novosShiniesDetectados = 0;

        for (const { mobKey, mob } of shiniesVivosPacote) {
            tempoUltimoPacoteShiny = agora;

            if (shiniesVistosNoMapa.has(mobKey)) {
                const info = shiniesVistosNoMapa.get(mobKey);
                info.lastSeen = agora;
            } else {
                if (!shiniesProcessadosEDerrotados.has(mobKey)) {
                    shiniesVistosNoMapa.set(mobKey, {
                        firstSeen: agora,
                        lastSeen: agora,
                        speciesId: mob.speciesId || mob.species,
                        slot: mob.slot
                    });
                    novosShiniesDetectados++;
                }
            }
        }

        if (novosShiniesDetectados > 0) {
            shinyDetectadoNoMapa = true;
            tempoUltimoShiny = agora;
            for (let i = 0; i < novosShiniesDetectados; i++) {
                incrementarContadorShiny(true);
            }
            tocarSomShiny(true);
            if (typeof atualizarBannerDetectorShiny === "function") {
                atualizarBannerDetectorShiny();
            }
        } else if (shiniesVivosPacote.length > 0) {
            shinyDetectadoNoMapa = true;
            tempoUltimoShiny = agora;
            if (typeof atualizarBannerDetectorShiny === "function") {
                atualizarBannerDetectorShiny();
            }
        }

        for (const [key, info] of shiniesVistosNoMapa.entries()) {
            if (agora - info.lastSeen > 8000) {
                shiniesVistosNoMapa.delete(key);
            }
        }

        if (shiniesProcessadosEDerrotados.size > 100) {
            shiniesProcessadosEDerrotados.clear();
        }

        if (shiniesVistosNoMapa.size === 0 && (agora - tempoUltimoPacoteShiny > 4000)) {
            if (shinyDetectadoNoMapa && (agora - tempoUltimoShiny > 4000)) {
                shinyDetectadoNoMapa = false;
                if (typeof atualizarBannerDetectorShiny === "function") {
                    atualizarBannerDetectorShiny();
                }
            }
        }
    }

    // Escutador interno para detector de shiny via barramento WS
    window.addEventListener("justpokedex-ws-message", (evento) => {
        try {
            const parsed = evento.detail;
            if (!parsed) return;
            analisarShiniesNoPacote(parsed);
        } catch (e) { }
    });

    const NOMES_STATS = {
        hp: "HP",
        atk: "Ataque",
        def: "Defesa",
        spa: "Ataque especial",
        spd: "Defesa especial",
        vel: "Velocidade"
    };

    const NOMES_STATS_CURTOS = {
        hp: "HP",
        atk: "Atk",
        def: "Def",
        spa: "SpA",
        spd: "SpD",
        vel: "Vel"
    };

    const ICONES_STATS = {
        hp: "♥",
        atk: "⚔",
        def: "⬢",
        spa: "✦",
        spd: "⬟",
        vel: "➤"
    };

    let ultimoTexto = "";
    let ultimoPokemon = null;
    let pokemonManualAtual = null;
    let abaAtual = "leitor";
    let consultaEmAndamento = null;
    let formularioRecolhido = false;
    let pokemonFixado = null;
    let mouseTrackingEnabled = true;
    let historicoPokemon = [];

    // WebSocket Proxy & Damage tracker
    const danoPorGolpe = new Map();

    function extrairDanoDeObjeto(obj, depth = 0, resultados = []) {
        if (!obj || typeof obj !== "object" || depth > 6) return resultados;
        const nomeGolpe = obj.moveName || obj.attackName || obj.spellName ||
            (typeof obj.move === "string" ? obj.move : obj.move?.name) ||
            (typeof obj.attack === "string" ? obj.attack : null) ||
            (typeof obj.skill === "string" ? obj.skill : obj.skill?.name);
        const dano = Number(obj.damage ?? obj.dmg ?? obj.dano ?? obj.amount);
        if (typeof nomeGolpe === "string" && nomeGolpe.trim() && Number.isFinite(dano)) {
            resultados.push({
                name: nomeGolpe.trim(),
                dmg: dano,
                type: typeof obj.type === "string" ? obj.type : null,
                eff: Number.isFinite(Number(obj.eff)) ? Number(obj.eff) : null
            });
            return resultados;
        }
        for (const val of Object.values(obj)) {
            extrairDanoDeObjeto(val, depth + 1, resultados);
        }
        return resultados;
    }

    let ultimoGolpeUsado = null;

    function registrarDanos(dados) {
        const golpes = extrairDanoDeObjeto(dados);
        if (golpes.length === 0) return;
        for (const g of golpes) {
            const chave = g.name.toLowerCase();
            ultimoGolpeUsado = chave;
            const atual = danoPorGolpe.get(chave) || { count: 0, total: 0 };
            danoPorGolpe.set(chave, {
                name: g.name,
                lastDmg: g.dmg,
                total: atual.total + g.dmg,
                count: atual.count + 1,
                type: g.type || atual.type,
                eff: g.eff
            });
        }
        atualizarPainelMoves();
    }

    try {
        const originalWS = window.WebSocket;
        window.WebSocket = new Proxy(originalWS, {
            construct(target, args) {
                const ws = new target(...args);
                ws.addEventListener("message", (event) => {
                    try {
                        if (typeof event.data === "string") {
                            const parsed = JSON.parse(event.data);
                            registrarDanos(parsed);
                        }
                    } catch (e) { }
                });
                return ws;
            }
        });
        window.WebSocket.prototype = originalWS.prototype;
    } catch (e) {
        console.warn("[Poké Leitor] Falha ao interceptar WebSocket:", e);
    }

    const SPRITE_ONERROR = "if(this.dataset.fallback){this.src=this.dataset.fallback;this.dataset.fallback='';}else{this.style.display='none'}";
    const CACHE_KEY = "pokemon-api-cache";
    let apiCache = {};
    try {
        apiCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch (e) { }

    function salvarCache() {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(apiCache));
        } catch (e) { }
    }

    function isShiny(pokemon) {
        if (!pokemon) return false;
        if (pokemon.nome && pokemon.nome.toLowerCase().includes("shiny")) return true;
        if (pokemon.multiplicadorQualidade > 1.8) return true;
        if (pokemon.qualidade && pokemon.qualidade.toLowerCase().includes("shiny")) return true;
        return false;
    }

    function obterEtiquetaQualidade(multiplicador) {
        const m = Number(multiplicador) || 1.0;
        if (m < 1.0) return { label: "Fraca", color: "#9e9e9e" };
        if (m < 1.1) return { label: "Comum", color: "#a8a8a8" };
        if (m < 1.3) return { label: "Incomum", color: "#5ed7b9" };
        if (m < 1.5) return { label: "Rara", color: "#69b7ff" };
        if (m < 1.7) return { label: "Épica", color: "#d985ff" };
        if (m < 2.0) return { label: "Lendária", color: "#f1c644" };
        if (m < 3.0) return { label: "Mítica", color: "#ff6680" };
        if (m < 4.0) return { label: "Anciã", color: "#ff9800" };
        return { label: "Divina", color: "#00bcd4" };
    }

    function obterUrlsSprite(id, shiny) {
        const pastaShiny = shiny ? "shiny/" : "";
        const baseUrl = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
        return {
            anim: `${baseUrl}/versions/generation-v/black-white/animated/${pastaShiny}${id}.gif`,
            still: `${baseUrl}/${pastaShiny}${id}.png`
        };
    }

    const TYPE_SYSTEM = {
        CHART: {
            normal: { rock: 0.5, ghost: 0, steel: 0.5 },
            fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
            water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
            electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
            grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
            ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
            fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
            poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
            ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
            flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
            psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
            bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
            rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
            ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
            dragon: { dragon: 2, steel: 0.5, fairy: 0 },
            dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
            steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
            fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
        },
        COLORS: {
            normal: "#a8a878",
            fire: "#f08030",
            water: "#6890f0",
            electric: "#f8d030",
            grass: "#78c850",
            ice: "#98d8d8",
            fighting: "#c03028",
            poison: "#a040a0",
            ground: "#e0c068",
            flying: "#a890f0",
            psychic: "#f85888",
            bug: "#a8b820",
            rock: "#b8a038",
            ghost: "#705898",
            dragon: "#7038f8",
            dark: "#705848",
            steel: "#b8b8d0",
            fairy: "#ee99ac"
        },
        TRADUCOES: {
            normal: "Normal",
            fire: "Fogo",
            water: "Água",
            electric: "Elétrico",
            grass: "Planta",
            ice: "Gelo",
            fighting: "Lutador",
            poison: "Veneno",
            ground: "Terra",
            flying: "Voador",
            psychic: "Psíquico",
            bug: "Inseto",
            rock: "Pedra",
            ghost: "Fantasma",
            dragon: "Dragão",
            dark: "Sombrio",
            steel: "Aço",
            fairy: "Fada"
        },
        TRADUCOES_INVERSAS: {
            "normal": "normal",
            "fogo": "fire",
            "agua": "water",
            "eletrico": "electric",
            "planta": "grass",
            "gelo": "ice",
            "lutador": "fighting",
            "veneno": "poison",
            "terra": "ground",
            "voador": "flying",
            "psiquico": "psychic",
            "inseto": "bug",
            "pedra": "rock",
            "fantasma": "ghost",
            "dragao": "dragon",
            "sombrio": "dark",
            "aco": "steel",
            "fada": "fairy"
        }
    };

    function obterChaveTipo(tipoPt) {
        if (!tipoPt) return null;
        const pt = tipoPt.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (TYPE_SYSTEM.COLORS[pt]) {
            return pt;
        }
        return TYPE_SYSTEM.TRADUCOES_INVERSAS[pt] || null;
    }

    function typeBadgeHtml(tipoEng) {
        const cor = TYPE_SYSTEM.COLORS[tipoEng] || "#888";
        const nomePt = TYPE_SYSTEM.TRADUCOES[tipoEng] || tipoEng;
        return `<span class="type-badge" style="background:${cor}; color:#fff; font-size:9.5px; font-weight:bold; padding:2px 6px; border-radius:10px; display:inline-block; line-height:1.2; text-shadow:0 1px 2px rgba(0,0,0,0.6);">${escapeHtml(nomePt)}</span>`;
    }

    function obterEfetividadeHtml(pokemon) {
        const tiposEng = pokemon.tipos
            .map(t => obterChaveTipo(t))
            .filter(Boolean);

        if (tiposEng.length === 0) return "";

        const todosTipos = Object.keys(TYPE_SYSTEM.CHART);
        const a = tiposEng.map(t => new Set(todosTipos.filter(def => TYPE_SYSTEM.CHART[t][def] === 2)));
        const da4x = tiposEng.length === 2 ? todosTipos.filter(def => a[0].has(def) && a[1].has(def)) : [];
        const da2x = todosTipos.filter(def => a.some(set => set.has(def)) && !da4x.includes(def));

        const toma4x = [];
        const toma2x = [];
        const imune = [];

        for (const atk of todosTipos) {
            const multiplicador = tiposEng.reduce((acc, def) => acc * (TYPE_SYSTEM.CHART[atk][def] ?? 1), 1);
            if (multiplicador === 2) {
                toma2x.push(atk);
            } else if (multiplicador === 4) {
                toma4x.push(atk);
            } else if (multiplicador === 0) {
                imune.push(atk);
            }
        }

        const criarLinhaEfetividade = (icone, rotulo, lista, corTexto) => {
            if (lista.length === 0) return "";
            return `
                <div class="eff-row" style="display: flex; align-items: center; gap: 6px; margin: 4px 0; font-size: 11px;">
                    <span class="eff-label" style="color:${corTexto}; font-weight: bold; width: 68px; flex-shrink: 0; font-size: 10.5px;">${icone} ${escapeHtml(rotulo)}</span>
                    <div class="eff-badges" style="display: flex; flex-wrap: wrap; gap: 3px 4px;">
                        ${lista.map(t => typeBadgeHtml(t)).join("")}
                    </div>
                </div>
            `;
        };

        return `
            <div class="efetividade-card" style="margin-top: 8px; padding: 8px; background: rgba(0, 0, 0, 0.2); border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.05);">
                <div class="sec-title" style="font-size: 9.5px; font-weight: bold; letter-spacing: 0.6px; text-transform: uppercase; color: #94a3b8; margin-bottom: 6px;">📊 Efetividade</div>
                ${criarLinhaEfetividade("⚔", "Dá 4x", da4x, "#ffd54a")}
                ${criarLinhaEfetividade("⚔", "Dá 2x", da2x, "#61f6a4")}
                ${criarLinhaEfetividade("🛡", "Toma 4x", toma4x, "#ff6b6b")}
                ${criarLinhaEfetividade("🛡", "Toma 2x", toma2x, "#ffb04a")}
                ${criarLinhaEfetividade("🛡", "Imune", imune, "#85c5ff")}
            </div>
        `;
    }

    function gerarUrlPIWTools(pokemon) {
        if (!pokemon) return "https://piwtools.pages.dev/hunt";
        const nome = normalizarNomePokemon(pokemon.nome) || String(pokemon.nome || "").toLowerCase().trim();
        const level = pokemon.nivel ?? 1;
        const hp = pokemon.hp ?? 0;
        const atk = pokemon.atk ?? 0;
        const def = pokemon.def ?? 0;
        const spatk = pokemon.spa ?? 0;
        const spdef = pokemon.spd ?? 0;
        const speed = pokemon.vel ?? 0;
        return `https://piwtools.pages.dev/hunt?pokemon=${encodeURIComponent(nome)}&level=${encodeURIComponent(level)}&hp=${encodeURIComponent(hp)}&atk=${encodeURIComponent(atk)}&def=${encodeURIComponent(def)}&spatk=${encodeURIComponent(spatk)}&spdef=${encodeURIComponent(spdef)}&speed=${encodeURIComponent(speed)}&tab=route&routeTarget=300`;
    }

    let creaturesData = [];
    let creaturesMapByName = new Map();

    async function carregarCreatures() {
        try {
            const resposta = await fetch("/game/creatures.json");
            if (resposta.ok) {
                const dados = await resposta.json();
                creaturesData = Array.isArray(dados?.creatures) ? dados.creatures : [];
                for (const c of creaturesData) {
                    if (c && c.name) {
                        creaturesMapByName.set(c.name.toLowerCase().trim(), c);
                    }
                }
                console.log("[Poké Leitor] Dados de creatures.json carregados:", creaturesMapByName.size);
            }
        } catch (e) {
            console.warn("[Poké Leitor] Não foi possível carregar creatures.json:", e);
        }
    }

    function obterMovesDoPokemon(pokemon) {
        if (!pokemon || !pokemon.nome) return [];

        const nomeBruto = pokemon.nome.toLowerCase().trim();
        const nomeNorm = normalizarNomePokemon(pokemon.nome).replace(/-/g, " ");

        let c = creaturesMapByName.get(nomeBruto) || creaturesMapByName.get(nomeNorm);

        if (!c) {
            for (const [key, val] of creaturesMapByName.entries()) {
                if (key.includes(nomeNorm) || (nomeNorm && nomeNorm.includes(key))) {
                    c = val;
                    break;
                }
            }
        }
        if (!c) return [];

        const extrair = s => {
            if (typeof s === "string") return { name: s };
            if (!s || typeof s !== "object") return null;
            const nome = s.name || s.moveName || s.move || s.id;
            return nome ? {
                name: String(nome),
                power: s.power ?? s.basePower ?? s.damage ?? s.dmg ?? null,
                type: s.type ? String(s.type) : (s.element ? String(s.element) : null)
            } : null;
        };

        const listaOriginais = [c.moves, c.attacks, c.skills, c.spells];
        for (const arr of listaOriginais) {
            if (Array.isArray(arr) && arr.length > 0) {
                return arr.map(extrair).filter(Boolean);
            }
        }
        return [];
    }

    let mostrarAbaMoves = false;

    function alternarPainelMoves() {
        const movesPanel = document.getElementById("moves-panel");
        const btnMovesHeader = document.getElementById("toggle-moves");
        const btnTab = document.querySelector('[data-tab="moves"]');
        if (!movesPanel) return;

        mostrarAbaMoves = !mostrarAbaMoves;
        movesPanel.style.display = mostrarAbaMoves ? "flex" : "none";

        if (btnMovesHeader) {
            btnMovesHeader.style.opacity = mostrarAbaMoves ? "1" : "1";
            btnMovesHeader.style.background = mostrarAbaMoves ? "rgba(255,255,255,0.2)" : "";
            btnMovesHeader.style.border = mostrarAbaMoves ? "1px solid rgba(255,255,255,0.4)" : "";
        }

        if (btnTab) {
            btnTab.classList.toggle("active", mostrarAbaMoves);
        }

        if (mostrarAbaMoves) {
            atualizarPainelMoves();
            atualizarPosicaoPainelMoves();
        }
    }

    function atualizarPosicaoPainelMoves() {
        const mainPanel = document.getElementById(CONFIG.panelId);
        const movesPanel = document.getElementById("moves-panel");
        if (!mainPanel || !movesPanel || movesPanel.style.display === "none") return;

        const rect = mainPanel.getBoundingClientRect();
        let left = rect.right + 8;

        if (left + 300 > window.innerWidth - 8) {
            left = rect.left - 308;
        }

        movesPanel.style.left = `${Math.max(8, left)}px`;
        movesPanel.style.top = `${rect.top}px`;
        movesPanel.style.height = "auto";
        movesPanel.style.maxHeight = `calc(100vh - ${rect.top + 16}px)`;
    }



    function atualizarPainelMoves() {
        const movesPanel = document.getElementById("moves-panel");
        if (!movesPanel || movesPanel.style.display === "none") return;

        if (!ultimoPokemon) {
            movesPanel.innerHTML = `
                <div class="moves-header">
                    <strong>⚔ Golpes</strong>
                </div>
                <div class="moves-body" style="display: flex; align-items: center; justify-content: center; flex: 1; padding: 20px; color: #8c98aa; text-align: center;">
                    <div>
                        <div class="loading-ball-mini" style="width: 24px; height: 24px; border: 1.5px solid #171717; border-radius: 50%; background: linear-gradient(to bottom, #f34848 0%, #f34848 43%, #151515 43%, #151515 57%, #f7f7f7 57%); animation: spin 1.1s linear infinite; position: relative;"><span style="position: absolute; top: 50%; left: 50%; width: 6px; height: 6px; border: 1px solid #171717; border-radius: 50%; background: #fff; transform: translate(-50%, -50%);"></span></div>
                        <strong>Aguardando Pokémon</strong>
                        <small style="display: block; margin-top: 5px; font-size: 11px;">Passe o mouse sobre um Pokémon.</small>
                    </div>
                </div>
            `;
            return;
        }

        const moves = obterMovesDoPokemon(ultimoPokemon);

        if (moves.length === 0) {
            movesPanel.innerHTML = `
                <div class="moves-header">
                    <strong>⚔ Golpes — ${escapeHtml(ultimoPokemon.nome)}</strong>
                </div>
                <div class="moves-body" style="display: flex; align-items: center; justify-content: center; flex: 1; padding: 20px; color: #8c98aa; text-align: center;">
                    <div>
                        <strong>Sem golpes cadastrados</strong>
                        <small style="display: block; margin-top: 5px; font-size: 11px;">Não encontramos golpes em creatures.json.</small>
                    </div>
                </div>
            `;
            return;
        }

        const nomesNossosGolpes = new Set(moves.map(m => m.name.toLowerCase().trim()));

        let html = `
            <div class="moves-header">
                <strong>⚔ Moves — ${escapeHtml(ultimoPokemon.nome)}</strong>
            </div>
            <div class="moves-body" style="padding: 10px; display: flex; flex-direction: column; gap: 8px;">
        `;

        for (const m of moves) {
            const chave = m.name.toLowerCase().trim();
            const danoInfo = danoPorGolpe.get(chave);
            const tipoEng = m.type ? obterChaveTipo(m.type) : null;
            const badgeHtml = tipoEng ? typeBadgeHtml(tipoEng) : "";
            const isAtivo = ultimoGolpeUsado === chave;

            if (isAtivo) {
                const dmgFormatado = danoInfo ? formatarNumero(danoInfo.lastDmg) : "-";
                const effTexto = danoInfo && danoInfo.eff && danoInfo.eff !== 1 ? `${danoInfo.eff}x` : "";

                html += `
                    <div class="move-card active" style="display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 2px solid #f1c644; background: rgba(241,198,68,0.04); border-radius: 10px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                            <strong style="color: #fff; font-size: 11px; font-weight: bold; display: flex; align-items: center; gap: 4px;">
                                <span style="color: #ffd84f;">▶</span> ${escapeHtml(m.name)}
                            </strong>
                        </div>
                        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                ${badgeHtml}
                                ${m.power ? `<span style="color: #8c98aa; font-size: 9px;">poder ${m.power}</span>` : ""}
                            </div>
                            <span style="color: #ffd54a; font-weight: bold; font-size: 11px;">
                                💥 ${dmgFormatado} ${effTexto ? `<small style="font-size: 8px; opacity: 0.8; color: #6ee0a0;">${effTexto}</small>` : ""}
                            </span>
                        </div>
                    </div>
                `;
            } else {
                let danoExtraHtml = "";
                if (danoInfo) {
                    const dmgFormatado = formatarNumero(danoInfo.lastDmg);
                    danoExtraHtml = `<span style="color: #ffd54a; font-weight: bold; font-size: 10px; margin-left: 4px;">💥 ${dmgFormatado}</span>`;
                }

                html += `
                    <div class="move-card" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; min-height: 32px;">
                        <strong style="color: #fff; font-size: 11px; font-weight: normal; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${escapeHtml(m.name)}
                        </strong>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            ${badgeHtml}
                            ${m.power ? `<span style="color: #8c98aa; font-size: 9px;">poder ${m.power}</span>` : ""}
                            ${danoExtraHtml}
                        </div>
                    </div>
                `;
            }
        }

        const golpesTomados = Array.from(danoPorGolpe.values())
            .filter(g => !nomesNossosGolpes.has(g.name.toLowerCase().trim()));

        if (golpesTomados.length > 0) {
            html += `
                <div class="section-divider" style="font-size: 8px; font-weight: bold; letter-spacing: 0.8px; text-transform: uppercase; color: #66758b; margin: 10px 0 2px 2px; display: flex; align-items: center; gap: 4px;">
                    <span>🛡️ GOLPES TOMADOS</span>
                    <span style="opacity: 0.5; font-size: 7px; font-weight: normal;">- nesta hunt</span>
                </div>
            `;

            for (const g of golpesTomados) {
                const tipoEng = g.type ? obterChaveTipo(g.type) : null;
                const badgeHtml = tipoEng ? typeBadgeHtml(tipoEng) : "";
                const dmgFormatado = formatarNumero(g.lastDmg);

                html += `
                    <div class="move-card taken" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(240,90,98,0.02); border: 1px solid rgba(240,90,98,0.06); border-radius: 10px; min-height: 32px;">
                        <strong style="color: #edf4ff; font-size: 11px; font-weight: normal; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${escapeHtml(g.name)}
                        </strong>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            ${badgeHtml}
                            <span style="color: #ff7a83; font-weight: bold; font-size: 10px; display: flex; align-items: center; gap: 2px;">
                                🛡️ ${dmgFormatado}
                            </span>
                        </div>
                    </div>
                `;
            }
        }

        html += `</div>`;
        movesPanel.innerHTML = html;
    }

    let mostrarAbaItens = false;
    let categoriaItemSelecionada = "TODAS";
    let itemSelecionado = null;
    let filtroBuscaItem = "";
    let listaItensGlobal = [];

    try {
        const cacheItensSalvo = localStorage.getItem("justpokedex-items-cache-v4");
        if (cacheItensSalvo) {
            const parsed = JSON.parse(cacheItensSalvo);
            if (Array.isArray(parsed)) {
                listaItensGlobal = parsed;
            }
        }
    } catch (e) { }

    function alternarPainelItens() {
        const itemsPanel = document.getElementById("items-panel");
        const btnItems = document.getElementById("toggle-items");
        if (!itemsPanel) return;

        mostrarAbaItens = !mostrarAbaItens;
        itemsPanel.style.display = mostrarAbaItens ? "flex" : "none";

        if (btnItems) {
            btnItems.style.opacity = mostrarAbaItens ? "1" : "0.7";
            btnItems.style.background = mostrarAbaItens ? "rgba(241,198,68,0.25)" : "";
            btnItems.style.border = mostrarAbaItens ? "1px solid rgba(241,198,68,0.5)" : "";
        }

        if (mostrarAbaItens) {
            carregarDadosItensPokepedia();
            atualizarPainelItens();
            atualizarPosicaoPainelItens();
        }
    }

    function atualizarPosicaoPainelItens() {
        const mainPanel = document.getElementById(CONFIG.panelId);
        const itemsPanel = document.getElementById("items-panel");
        if (!mainPanel || !itemsPanel || itemsPanel.style.display === "none") return;

        const rect = mainPanel.getBoundingClientRect();
        const movesPanel = document.getElementById("moves-panel");
        const movesAberto = movesPanel && movesPanel.style.display !== "none";

        let left;
        if (!movesAberto && (rect.right + 8 + 360 <= window.innerWidth - 8)) {
            left = rect.right + 8;
        } else {
            left = rect.left - 368;
            if (left < 8) {
                left = Math.min(rect.right + 8, window.innerWidth - 368);
            }
        }

        itemsPanel.style.left = `${Math.max(8, left)}px`;
        itemsPanel.style.top = `${rect.top}px`;
        itemsPanel.style.height = "auto";
        itemsPanel.style.maxHeight = `calc(100vh - ${rect.top + 16}px)`;
    }

    async function carregarDadosItensPokepedia() {
        try {
            const cache = localStorage.getItem("justpokedex-items-cache-v4");
            if (cache) {
                const parsed = JSON.parse(cache);
                if (Array.isArray(parsed) && parsed.length > 50) {
                    listaItensGlobal = parsed;
                    if (mostrarAbaItens) atualizarPainelItens();
                }
            }
        } catch (e) { }

        try {
            const [resItems, resCreatures] = await Promise.all([
                fetch("/game/items.json"),
                fetch("/game/creatures.json")
            ]);

            if (resItems.ok && resCreatures.ok) {
                const itemsData = await resItems.json();
                const creaturesData = await resCreatures.json();

                const rawItems = itemsData.items || [];
                const creatures = (creaturesData.creatures || []).filter(c => c.pokeId < 10000);

                const dropsMap = new Map();
                for (const creature of creatures) {
                    for (const loot of (creature.loot || [])) {
                        const itemKey = loot.name.toLowerCase().trim();
                        if (!dropsMap.has(itemKey)) dropsMap.set(itemKey, []);
                        const chanceVal = loot.chance / 1000;
                        const chanceStr = chanceVal >= 1 ? `${chanceVal.toFixed(0)}%` : `${chanceVal.toFixed(2)}%`;
                        const qtyStr = loot.minCount === loot.maxCount ? `x${loot.maxCount}` : `x${loot.minCount}–${loot.maxCount}`;

                        dropsMap.get(itemKey).push({
                            pokemon: creature.name,
                            id: creature.pokeId,
                            chanceNum: chanceVal,
                            chance: chanceStr,
                            quantidade: qtyStr
                        });
                    }
                }

                const catMap = {
                    stone: "PEDRA",
                    heal: "CURA",
                    revive: "REVIVER",
                    loot: "LOOT",
                    ball: "BALL",
                    misc: "DIVERSOS",
                    item: "ITEM",
                    vitamin: "VITAMINA",
                    energy: "ENERGIA",
                    card: "SHINY CARD",
                    clan: "CLAN",
                    tm: "TM"
                };

                const itensProcessados = rawItems.map(item => {
                    let iconUrl = item.icon || "";
                    if (iconUrl.startsWith("/")) {
                        iconUrl = window.location.origin + iconUrl;
                    }

                    const drops = (dropsMap.get(item.name.toLowerCase().trim()) || [])
                        .sort((a, b) => b.chanceNum - a.chanceNum);

                    const precoFormatado = item.npcPrice ? `$ ${item.npcPrice.toLocaleString('pt-BR')}` : "";

                    return {
                        id: item.id,
                        nome: item.name,
                        categoria: catMap[(item.category || "item").toLowerCase()] || (item.category || "ITEM").toUpperCase(),
                        rawCategory: (item.category || "item").toLowerCase(),
                        preco: precoFormatado,
                        icone: iconUrl,
                        dropadoPor: drops
                    };
                });

                if (itensProcessados.length > 0) {
                    listaItensGlobal = itensProcessados;
                    try {
                        localStorage.setItem("justpokedex-items-cache-v4", JSON.stringify(listaItensGlobal));
                    } catch (e) { }
                    if (mostrarAbaItens) atualizarPainelItens();
                }
            }
        } catch (err) {
            console.error("[JustPokédex] Erro ao carregar itens de /game/items.json:", err);
        }
    }

    function selecionarPokemonDoDrop(nomePokemon) {
        if (!nomePokemon) return;
        const p = encontrarPokemonPorNome(nomePokemon);
        if (p) {
            exibirPokemon(p);
            trocarAba("leitor");
        }
    }

    function atualizarPainelItens() {
        const itemsPanel = document.getElementById("items-panel");
        if (!itemsPanel || itemsPanel.style.display === "none") return;

        const categorias = ["TODAS", "LOOT", "PEDRA", "CURA", "REVIVER", "BALL", "TM", "SHINY CARD", "DIVERSOS"];

        let htmlHeader = `
            <div class="items-header">
                <strong style="color: #ffe984; font-size: 12px; display: flex; align-items: center; gap: 5px;">🎒 Poképedia — Itens & Drops (${listaItensGlobal.length})</strong>
                <button id="btn-fechar-itens" type="button" style="background: transparent; border: none; color: #a2b4cf; font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1;" title="Fechar">✕</button>
            </div>
        `;

        if (itemSelecionado) {
            let dropsHtml = "";
            if (itemSelecionado.dropadoPor && itemSelecionado.dropadoPor.length > 0) {
                dropsHtml = itemSelecionado.dropadoPor.map(d => `
                    <div class="drop-poke-row" data-poke="${escapeHtml(d.pokemon)}" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; cursor: pointer; transition: background 0.15s ease;">
                        <span style="color: #93c5fd; font-size: 11px; font-weight: bold; text-decoration: underline;" title="Clique para abrir na Pokédex">🐾 ${escapeHtml(d.pokemon)}</span>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="color: #94a3b8; font-size: 10px;">${escapeHtml(d.quantidade || "x1")}</span>
                            <span style="color: #4ade80; font-weight: bold; font-size: 10.5px; background: rgba(74,222,128,0.1); padding: 1px 6px; border-radius: 4px;">${escapeHtml(d.chance)}</span>
                        </div>
                    </div>
                `).join("");
            } else {
                dropsHtml = `
                    <div style="padding: 20px; text-align: center; color: #64748b; font-size: 11px;">
                        Nenhum Pokémon cadastrado como drop para este item.
                    </div>
                `;
            }

            itemsPanel.innerHTML = `
                ${htmlHeader}
                <div class="items-body" style="padding: 10px; display: flex; flex-direction: column; gap: 10px;">
                    <button id="btn-voltar-lista-itens" style="align-self: flex-start; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #cbd5e1; font-size: 10px; font-weight: bold; padding: 4px 10px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                        ‹ Voltar para a lista de itens
                    </button>
                    
                    <div style="display: flex; align-items: center; gap: 10px; padding: 10px; background: rgba(241,198,68,0.08); border: 1px solid rgba(241,198,68,0.3); border-radius: 10px;">
                        <img src="${escapeHtml(itemSelecionado.icone)}" style="width: 36px; height: 36px; object-fit: contain; border-radius: 4px;" onerror="this.onerror=null; this.src='https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png';">
                        <div style="flex: 1; min-width: 0;">
                            <strong style="color: #fff; font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(itemSelecionado.nome)}</strong>
                            <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
                                <span style="background: rgba(255,255,255,0.1); color: #cbd5e1; font-size: 9px; font-weight: bold; padding: 1px 6px; border-radius: 4px;">${escapeHtml(itemSelecionado.categoria)}</span>
                                ${itemSelecionado.preco ? `<span style="background: rgba(46,125,50,0.3); border: 1px solid rgba(76,175,80,0.4); color: #81c784; font-size: 9px; font-weight: bold; padding: 1px 6px; border-radius: 4px;">${escapeHtml(itemSelecionado.preco)} (NPC)</span>` : ""}
                            </div>
                        </div>
                    </div>

                    <div style="font-size: 9px; font-weight: bold; letter-spacing: 0.8px; text-transform: uppercase; color: #f1c644; margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                        <span>⚡ DROPADO POR (${itemSelecionado.dropadoPor ? itemSelecionado.dropadoPor.length : 0})</span>
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 6px; max-height: 340px; overflow-y: auto;">
                        ${dropsHtml}
                    </div>
                </div>
            `;

            const btnVoltar = itemsPanel.querySelector("#btn-voltar-lista-itens");
            if (btnVoltar) {
                btnVoltar.onclick = () => {
                    itemSelecionado = null;
                    atualizarPainelItens();
                };
            }

            const dropPokeRows = itemsPanel.querySelectorAll(".drop-poke-row");
            dropPokeRows.forEach(row => {
                row.onclick = () => {
                    const nomePoke = row.getAttribute("data-poke");
                    if (nomePoke) selecionarPokemonDoDrop(nomePoke);
                };
            });
        } else {
            const filtroLower = filtroBuscaItem.toLowerCase().trim();
            const itensFiltrados = listaItensGlobal.filter(item => {
                const bateNome = !filtroLower || item.nome.toLowerCase().includes(filtroLower);
                const catUpper = (item.categoria || "").toUpperCase();
                const rawCatUpper = (item.rawCategory || "").toUpperCase();
                const bateCat = categoriaItemSelecionada === "TODAS" ||
                    catUpper.includes(categoriaItemSelecionada) ||
                    rawCatUpper.includes(categoriaItemSelecionada);
                return bateNome && bateCat;
            });

            itemsPanel.innerHTML = `
                ${htmlHeader}
                <div style="padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(0,0,0,0.2);">
                    <div style="position: relative; display: flex; align-items: center; gap: 6px; background: #111722; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 6px 10px; margin-bottom: 8px;">
                        <span style="color: #66758a; font-size: 12px;">🔍</span>
                        <input type="text" id="input-busca-item" placeholder="Buscar item por nome (ex: Air Tank)..." value="${escapeHtml(filtroBuscaItem)}" style="flex: 1; background: transparent; border: none; color: #fff; font-size: 11px; outline: none; padding: 0;">
                        ${filtroBuscaItem ? `<button id="btn-limpar-busca-item" style="background: transparent; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 0;">×</button>` : ""}
                    </div>
                    <div style="display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin;">
                        ${categorias.map(cat => `
                            <button class="pill-cat-filter" data-cat="${cat}" style="background: ${categoriaItemSelecionada === cat ? "rgba(241,198,68,0.25)" : "rgba(255,255,255,0.05)"}; border: 1px solid ${categoriaItemSelecionada === cat ? "#f1c644" : "rgba(255,255,255,0.08)"}; color: ${categoriaItemSelecionada === cat ? "#ffe984" : "#94a3b8"}; font-size: 9px; font-weight: bold; padding: 2px 7px; border-radius: 12px; cursor: pointer; white-space: nowrap;">
                                ${cat}
                            </button>
                        `).join("")}
                    </div>
                </div>

                <div class="items-body" style="padding: 10px; max-height: 400px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;">
                    ${itensFiltrados.length > 0 ? itensFiltrados.map((item, idx) => `
                        <div class="item-row-card" data-idx="${idx}" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; cursor: pointer; transition: all 0.15s ease;">
                            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
                                <img src="${escapeHtml(item.icone)}" style="width: 24px; height: 24px; object-fit: contain; border-radius: 3px;" onerror="this.onerror=null; this.src='https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png';">
                                <div style="min-width: 0;">
                                    <strong style="color: #fff; font-size: 11px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.nome)}</strong>
                                    <div style="display: flex; align-items: center; gap: 4px; margin-top: 2px;">
                                        <span style="background: rgba(255,255,255,0.08); color: #cbd5e1; font-size: 8px; font-weight: bold; padding: 0 4px; border-radius: 3px;">${escapeHtml(item.categoria)}</span>
                                        ${item.preco ? `<span style="color: #81c784; font-size: 8px; font-weight: bold;">${escapeHtml(item.preco)}</span>` : ""}
                                    </div>
                                </div>
                            </div>
                            <span style="color: #64748b; font-size: 14px; font-weight: bold;">›</span>
                        </div>
                    `).join("") : `
                        <div style="padding: 30px 10px; text-align: center; color: #64748b; font-size: 11px;">
                            Nenhum item encontrado com "${escapeHtml(filtroBuscaItem)}".
                        </div>
                    `}
                </div>
            `;

            const inputBusca = itemsPanel.querySelector("#input-busca-item");
            if (inputBusca) {
                inputBusca.oninput = (e) => {
                    filtroBuscaItem = e.target.value;
                    atualizarPainelItens();
                    const newInp = itemsPanel.querySelector("#input-busca-item");
                    if (newInp) {
                        newInp.focus();
                        newInp.setSelectionRange(newInp.value.length, newInp.value.length);
                    }
                };
            }

            const btnLimparBusca = itemsPanel.querySelector("#btn-limpar-busca-item");
            if (btnLimparBusca) {
                btnLimparBusca.onclick = () => {
                    filtroBuscaItem = "";
                    atualizarPainelItens();
                };
            }

            const catButtons = itemsPanel.querySelectorAll(".pill-cat-filter");
            catButtons.forEach(btn => {
                btn.onclick = () => {
                    categoriaItemSelecionada = btn.getAttribute("data-cat");
                    atualizarPainelItens();
                };
            });

            const itemCards = itemsPanel.querySelectorAll(".item-row-card");
            itemCards.forEach(card => {
                card.onclick = () => {
                    const idx = parseInt(card.getAttribute("data-idx"), 10);
                    if (itensFiltrados[idx]) {
                        itemSelecionado = itensFiltrados[idx];
                        atualizarPainelItens();
                    }
                };
            });
        }

        const btnFechar = itemsPanel.querySelector("#btn-fechar-itens");
        if (btnFechar) {
            btnFechar.onclick = () => {
                alternarPainelItens();
            };
        }
    }

    function numero(texto) {
        if (
            texto === null ||
            texto === undefined ||
            texto === ""
        ) {
            return null;
        }

        const convertido = Number(
            String(texto)
                .replace(/\s/g, "")
                .replace(/\./g, "")
                .replace(",", ".")
                .trim()
        );

        return Number.isFinite(convertido)
            ? convertido
            : null;
    }

    function numeroDecimal(texto) {
        if (
            texto === null ||
            texto === undefined ||
            texto === ""
        ) {
            return null;
        }

        const convertido = Number(
            String(texto)
                .replace(",", ".")
                .replace(/[^\d.-]/g, "")
        );

        return Number.isFinite(convertido)
            ? convertido
            : null;
    }

    function limitar(valor, minimo, maximo) {
        return Math.min(
            maximo,
            Math.max(minimo, valor)
        );
    }

    function arredondar(valor, casas = 1) {
        const fator = 10 ** casas;
        return Math.round(valor * fator) / fator;
    }

    function parsePokemon(texto) {
        if (!texto) return null;

        const linhas = texto
            .split("\n")
            .map(linha => linha.trim())
            .filter(Boolean);

        if (!linhas.length) return null;

        const nome = linhas[0] || "Desconhecido";
        const tipos = [];

        for (const linha of linhas.slice(1)) {
            if (
                /^(Ativo|Nv\s|Qualidade|IV\s|HP\s|Atk\s|Def\s|SpA\s|SpD\s|Vel\s|.*Poder)/i.test(
                    linha
                )
            ) {
                break;
            }

            tipos.push(linha);
        }

        const ivMatch =
            texto.match(/IV\s*(\d+)\s*\/\s*(\d+)/i);

        const qualidadeTexto =
            texto.match(/Qualidade\s+([^\n]+)/i)?.[1]?.trim() ||
            null;

        const multiplicador =
            numeroDecimal(
                qualidadeTexto?.match(
                    /(?:×|x)\s*([\d.,]+)/i
                )?.[1]
            );

        return {
            nome,
            tipos,

            ativo: linhas.some(linha =>
                linha.toLowerCase().includes("ativo")
            ),

            nivel: numero(
                texto.match(/Nv\s*(\d+)/i)?.[1]
            ),

            qualidade: qualidadeTexto,
            multiplicadorQualidade: multiplicador,

            ivAtual: numero(ivMatch?.[1]),
            ivMaximo: numero(ivMatch?.[2]),

            hp: numero(
                texto.match(/HP\s+([\d.,]+)/i)?.[1]
            ),

            atk: numero(
                texto.match(/Atk\s+([\d.,]+)/i)?.[1]
            ),

            def: numero(
                texto.match(/Def\s+([\d.,]+)/i)?.[1]
            ),

            spa: numero(
                texto.match(/SpA\s+([\d.,]+)/i)?.[1]
            ),

            spd: numero(
                texto.match(/SpD\s+([\d.,]+)/i)?.[1]
            ),

            vel: numero(
                texto.match(/Vel\s+([\d.,]+)/i)?.[1]
            ),

            poder: numero(
                texto.match(/Poder\s+([\d.,]+)/i)?.[1]
            )
        };
    }

    function escapeHtml(valor) {
        return String(valor ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function normalizarNomePokemon(nome) {
        if (!nome) return "";
        let n = String(nome)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") // Remove acentos
            .toLowerCase();

        // 1. Remove emojis e símbolos unicode
        n = n.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, "");

        // 2. Remove o termo "shiny" (palavra completa, sufixo ou prefixo)
        n = n.replace(/\bshiny\b/g, "").replace(/shiny/g, "");

        // 3. Normalizações de gênero e nomes Nidoran Male / Female
        n = n.replace(/\bnidoran\s*male\b|\bnidoran\s*m\b/g, "nidoran-m")
            .replace(/\bnidoran\s*female\b|\bnidoran\s*f\b/g, "nidoran-f")
            .replace(/♀/g, "-f")
            .replace(/♂/g, "-m");

        // 4. Mantém apenas letras, números, hífens e espaços
        n = n.replace(/[^a-z0-9\s-]/g, "").trim();

        // 5. Substitui espaços por hífen e limpa hífens extras
        n = n.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

        // 6. Mapeamento direto de slugs da PokeAPI
        const SLUG_MAP = {
            "nidoran-male": "nidoran-m",
            "nidoran-female": "nidoran-f",
            "nidoranm": "nidoran-m",
            "nidoranf": "nidoran-f",
            "mr-mime": "mr-mime",
            "mr-rime": "mr-rime",
            "mime-jr": "mime-jr",
            "type-null": "type-null",
            "ho-oh": "ho-oh",
            "porygon-z": "porygon-z",
            "jangmo-o": "jangmo-o",
            "hakamo-o": "hakamo-o",
            "kommo-o": "kommo-o",
            "tapu-koko": "tapu-koko",
            "tapu-lele": "tapu-lele",
            "tapu-bulu": "tapu-bulu",
            "tapu-fini": "tapu-fini"
        };

        return SLUG_MAP[n] || n;
    }

    function formatarNumero(valor) {
        if (
            valor === null ||
            valor === undefined ||
            !Number.isFinite(Number(valor))
        ) {
            return "-";
        }

        return new Intl.NumberFormat("pt-BR").format(valor);
    }

    function formatarDecimal(valor, casas = 1) {
        if (
            valor === null ||
            valor === undefined ||
            !Number.isFinite(Number(valor))
        ) {
            return "-";
        }

        return Number(valor).toLocaleString(
            "pt-BR",
            {
                minimumFractionDigits: casas,
                maximumFractionDigits: casas
            }
        );
    }

    function linha(rotulo, valor) {
        if (
            valor === null ||
            valor === undefined ||
            valor === ""
        ) {
            return "";
        }

        return `
            <div class="row">
                <span>${escapeHtml(rotulo)}</span>

                <strong>
                    ${escapeHtml(String(valor))}
                </strong>
            </div>
        `;
    }

    function salvarEstadoPainel(painel) {
        try {
            const rect = painel.getBoundingClientRect();
            const isMin = painel.classList.contains("minimized");

            let anterior = {};
            try {
                const salvo = localStorage.getItem(CONFIG.storageKey);
                if (salvo) anterior = JSON.parse(salvo);
            } catch (e) { }

            const estado = {
                left: rect.left,
                top: rect.top,
                width: isMin ? (anterior.width || 340) : rect.width,
                height: isMin ? (anterior.height || null) : rect.height,
                minimized: isMin,
                abaAtual,
                formularioRecolhido
            };

            localStorage.setItem(
                CONFIG.storageKey,
                JSON.stringify(estado)
            );
        } catch (erro) {
            console.warn(
                "[Poké Leitor] Não foi possível salvar o painel.",
                erro
            );
        }
    }

    function restaurarEstadoPainel(painel) {
        try {
            const salvo =
                localStorage.getItem(CONFIG.storageKey);

            if (!salvo) return;

            const estado = JSON.parse(salvo);

            if (Number.isFinite(estado.left)) {
                painel.style.left = `${estado.left}px`;
                painel.style.right = "auto";
            }

            if (Number.isFinite(estado.top)) {
                painel.style.top = `${estado.top}px`;
            }

            if (Number.isFinite(estado.width) && estado.width > 100) {
                painel.style.width = `${estado.width}px`;
            }

            if (Number.isFinite(estado.height) && estado.height > 100) {
                painel.style.height = `${estado.height}px`;
            }

            if (estado.minimized) {
                painel.classList.add("minimized");
            }

            if (
                estado.abaAtual === "leitor" ||
                estado.abaAtual === "analise" ||
                estado.abaAtual === "comparacao" ||
                estado.abaAtual === "captura"
            ) {
                abaAtual = estado.abaAtual;
            }

            formularioRecolhido =
                Boolean(estado.formularioRecolhido);
        } catch (erro) {
            console.warn(
                "[Poké Leitor] Não foi possível restaurar o painel.",
                erro
            );
        }
    }

    function ativarRedimensionamento(painel) {
        const handle = document.getElementById("resize-handle");
        if (!handle) return;

        let startWidth, startHeight, startX, startY;

        handle.addEventListener("mousedown", initResize, false);
        handle.addEventListener("touchstart", initResizeTouch, { passive: false });

        function initResize(e) {
            e.preventDefault();
            e.stopPropagation();

            startWidth = painel.offsetWidth;
            startHeight = painel.offsetHeight;
            startX = e.clientX;
            startY = e.clientY;

            document.documentElement.addEventListener("mousemove", doResize, false);
            document.documentElement.addEventListener("mouseup", stopResize, false);
        }

        function doResize(e) {
            const newWidth = Math.max(260, startWidth + (e.clientX - startX));
            const newHeight = Math.max(180, startHeight + (e.clientY - startY));

            painel.style.width = newWidth + "px";
            painel.style.height = newHeight + "px";
        }

        function stopResize() {
            document.documentElement.removeEventListener("mousemove", doResize, false);
            document.documentElement.removeEventListener("mouseup", stopResize, false);

            salvarEstadoPainel(painel);
        }

        function initResizeTouch(e) {
            e.preventDefault();
            e.stopPropagation();

            startWidth = painel.offsetWidth;
            startHeight = painel.offsetHeight;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;

            document.documentElement.addEventListener("touchmove", doResizeTouch, { passive: false });
            document.documentElement.addEventListener("touchend", stopResizeTouch, false);
        }

        function doResizeTouch(e) {
            const newWidth = Math.max(260, startWidth + (e.touches[0].clientX - startX));
            const newHeight = Math.max(180, startHeight + (e.touches[0].clientY - startY));

            painel.style.width = newWidth + "px";
            painel.style.height = newHeight + "px";
        }

        function stopResizeTouch() {
            document.documentElement.removeEventListener("touchmove", doResizeTouch);
            document.documentElement.removeEventListener("touchend", stopResizeTouch);

            salvarEstadoPainel(painel);
        }
    }

    function limitarPainelNaTela(painel) {
        const rect = painel.getBoundingClientRect();

        const maxLeft = Math.max(
            0,
            window.innerWidth - rect.width
        );

        const maxTop = Math.max(
            0,
            window.innerHeight - rect.height
        );

        painel.style.left = `${Math.min(
            Math.max(0, rect.left),
            maxLeft
        )
            }px`;

        painel.style.top = `${Math.min(
            Math.max(0, rect.top),
            maxTop
        )
            }px`;

        painel.style.right = "auto";

        atualizarPosicaoPainelMoves();
        atualizarPosicaoPainelItens();
    }

    function atualizarBotaoMinimizar(painel) {
        const botao =
            document.getElementById("minimize");

        if (!botao) return;

        const minimizado =
            painel.classList.contains("minimized");

        botao.textContent = minimizado ? "+" : "−";

        botao.title = minimizado
            ? "Restaurar"
            : "Minimizar";
    }

    function alternarMinimizado(painel) {
        painel.classList.toggle("minimized");

        if (painel.classList.contains("minimized")) {
            const movesPanelEl = document.getElementById("moves-panel");
            if (movesPanelEl) movesPanelEl.style.display = "none";
            mostrarAbaMoves = false;
            const btnMoves = document.querySelector('[data-tab="moves"]');
            if (btnMoves) btnMoves.classList.remove("active");

            const itemsPanelEl = document.getElementById("items-panel");
            if (itemsPanelEl) itemsPanelEl.style.display = "none";
            mostrarAbaItens = false;
            const btnItems = document.getElementById("toggle-items");
            if (btnItems) {
                btnItems.style.opacity = "1";
                btnItems.style.background = "";
                btnItems.style.border = "";
            }
        }

        atualizarBotaoMinimizar(painel);
        limitarPainelNaTela(painel);
        salvarEstadoPainel(painel);
    }

    function mostrarPainelCompleto() {
        const painel = document.getElementById(CONFIG.panelId);
        if (painel) {
            painel.style.display = "flex";
            limitarPainelNaTela(painel);
            salvarEstadoPainel(painel);
        }
    }

    function alternarVisibilidadePainel() {
        const painel = document.getElementById(CONFIG.panelId);
        if (!painel) return;

        if (painel.style.display === "none") {
            mostrarPainelCompleto();
        } else {
            painel.style.display = "none";
            const movesPanelEl = document.getElementById("moves-panel");
            if (movesPanelEl) movesPanelEl.style.display = "none";
            mostrarAbaMoves = false;
            const btn = document.querySelector('[data-tab="moves"]');
            if (btn) btn.classList.remove("active");

            const itemsPanelEl = document.getElementById("items-panel");
            if (itemsPanelEl) itemsPanelEl.style.display = "none";
            mostrarAbaItens = false;
            const btnItems = document.getElementById("toggle-items");
            if (btnItems) {
                btnItems.style.opacity = "1";
                btnItems.style.background = "";
                btnItems.style.border = "";
            }
        }
    }

    function ativarArraste(painel) {
        const handle =
            document.getElementById("drag-handle");

        if (!handle) return;

        let arrastando = false;
        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener("mousedown", evento => {
            if (evento.button !== 0) return;
            if (evento.target.closest("button")) return;

            arrastando = true;

            const rect =
                painel.getBoundingClientRect();

            offsetX = evento.clientX - rect.left;
            offsetY = evento.clientY - rect.top;

            painel.style.left = `${rect.left}px`;
            painel.style.top = `${rect.top}px`;
            painel.style.right = "auto";

            painel.classList.add("dragging");
            document.body.style.userSelect = "none";

            evento.preventDefault();
        });

        document.addEventListener("mousemove", evento => {
            if (!arrastando) return;

            const maxLeft = Math.max(
                0,
                window.innerWidth - painel.offsetWidth
            );

            const maxTop = Math.max(
                0,
                window.innerHeight - painel.offsetHeight
            );

            const left = Math.min(
                Math.max(
                    0,
                    evento.clientX - offsetX
                ),
                maxLeft
            );

            const top = Math.min(
                Math.max(
                    0,
                    evento.clientY - offsetY
                ),
                maxTop
            );

            painel.style.left = `${left}px`;
            painel.style.top = `${top}px`;

            atualizarPosicaoPainelMoves();
            atualizarPosicaoPainelItens();
        });

        document.addEventListener("mouseup", () => {
            if (!arrastando) return;

            arrastando = false;

            painel.classList.remove("dragging");
            document.body.style.userSelect = "";

            salvarEstadoPainel(painel);
        });

        window.addEventListener("resize", () => {
            limitarPainelNaTela(painel);
            salvarEstadoPainel(painel);
            atualizarPosicaoPainelMoves();
            atualizarPosicaoPainelItens();
        });
    }

    function htmlAguardando() {
        return `
            <div class="empty">
                <div class="empty-ball">
                    <span></span>
                </div>

                <strong>Aguardando Pokémon</strong>

                <small>
                    Passe o mouse sobre um Pokémon
                    do inventário.
                </small>
            </div>
        `;
    }

    function htmlAnaliseVazia() {
        return `
            <div class="analysis-empty">
                <div class="analysis-empty-icon">
                    <span>IV</span>
                </div>

                <strong>Análise de IV</strong>

                <span>
                    Passe o mouse sobre um Pokémon para
                    preencher os dados automaticamente.
                </span>

                <div class="empty-tips">
                    <div>
                        <b>1</b>
                        Selecione um Pokémon
                    </div>

                    <div>
                        <b>2</b>
                        Confira os atributos
                    </div>

                    <div>
                        <b>3</b>
                        Veja o potencial
                    </div>
                </div>
            </div>
        `;
    }

    function criarPainel() {
        if (
            document.getElementById(CONFIG.panelId)
        ) {
            return;
        }

        const painel = document.createElement("div");
        painel.id = CONFIG.panelId;

        painel.innerHTML = `
            <div class="header" id="drag-handle">
                <div class="title-area">
                    <div class="pokeball">
                        <span></span>
                    </div>

                    <div>
                        <strong>JustPokédex</strong>
                    </div>
                </div>

                <div class="header-actions">
                    <button
                        id="toggle-moves"
                        type="button"
                        style="margin-right: 3px; font-size: 11px; padding: 0 4px;"
                        title="Poképedia — Moves & Golpes (👊)"
                    >
                        👊
                    </button>

                    <button
                        id="toggle-items"
                        type="button"
                        style="margin-right: 3px; font-size: 11px; padding: 0 4px;"
                        title="Poképedia — Itens & Drops (🎒)"
                    >
                        🎒
                    </button>

                    <button
                        id="toggle-shiny"
                        type="button"
                        style="margin-right: 3px; font-size: 11px; padding: 0 4px;"
                    >
                        ✨
                    </button>

                    <button
                        id="toggle-daily"
                        type="button"
                        style="margin-right: 3px; font-size: 11px; padding: 0 4px;"
                    >
                        ⏳
                    </button>

                    <button
                        id="toggle-tracking"
                        type="button"
                        style="margin-right: 4.5px; font-size: 11px; padding: 0 4px;"
                    >
                        🐭
                    </button>

                    <button
                        id="minimize"
                        type="button"
                        title="Minimizar"
                    >
                        −
                    </button>

                    <button
                        id="close"
                        type="button"
                        title="Fechar"
                    >
                        ×
                    </button>
                </div>
            </div>

            <div class="led-area">
                <div class="main-led"></div>
                <div class="small-led led-red"></div>
                <div class="small-led led-yellow"></div>
                <div class="small-led led-green"></div>
            </div>

            <div class="top-banners-grid" style="display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid rgba(255,255,255,0.08); background: #0c121c; box-sizing: border-box; user-select: none; overflow: hidden;">
                <div id="shiny-detector-banner" style="
                    padding: 5px 8px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    font-size: 10px;
                    border-right: 1px solid rgba(255,255,255,0.08);
                    transition: all 0.3s ease;
                    box-sizing: border-box;
                    min-width: 0;
                "></div>

                <div id="daily-gift-banner" style="
                    padding: 5px 8px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    font-size: 10px;
                    transition: all 0.3s ease;
                    box-sizing: border-box;
                    min-width: 0;
                "></div>
            </div>

            <div id="panel-body">
                <div class="tabs">
                    <button
                        class="tab-button"
                        data-tab="leitor"
                        type="button"
                    >
                        <span class="tab-icon">◉</span>
                        Pokémon
                    </button>

                    <button
                        class="tab-button"
                        data-tab="analise"
                        type="button"
                    >
                        <span class="tab-icon">⌁</span>
                        Análise de IV
                    </button>

                    <button
                        class="tab-button"
                        data-tab="comparacao"
                        type="button"
                    >
                        <span class="tab-icon">⚖</span>
                        Comparar
                    </button>

                    <button
                        class="tab-button"
                        data-tab="captura"
                        type="button"
                    >
                        <span class="tab-icon">🎯</span>
                        Análise de Captura
                    </button>
                </div>

                <div
                    id="tab-leitor"
                    class="tab-content"
                >
                    <div id="content">
                        ${htmlAguardando()}
                    </div>

                    <div class="actions">
                        <button
                            id="fix"
                            type="button"
                            style="background: linear-gradient(#4d5a75, #2e3b52); border-color: #5c6c8c; color: #fff;"
                        >
                            📌 Fixar
                        </button>

                        <button
                            id="copy"
                            type="button"
                        >
                            📋 Copiar dados
                        </button>

                        <button
                            id="json"
                            type="button"
                        >
                            { } Copiar JSON
                        </button>
                    </div>
                </div>

                <div
                    id="tab-analise"
                    class="tab-content"
                >
                    <div class="analysis-search-container" style="padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); background: #0c131f; position: relative;">
                        <div style="position: relative; display: flex; align-items: center; gap: 8px; background: #151d2a; border: 1px solid rgba(255,255,255,0.09); border-radius: 8px; padding: 7px 10px; transition: border-color 0.15s ease;">
                            <span style="color: #66758a; font-size: 13px; flex: 0 0 auto; pointer-events: none;">🔍</span>
                            <input type="text" id="analysis-search-input" placeholder="Buscar Pokémon para análise manual..." style="flex: 1; background: transparent; border: none; color: #e2ecfa; font-size: 11px; outline: none; box-sizing: border-box; padding: 0;" onfocus="this.parentElement.style.borderColor='rgba(202,48,53,0.5)'" onblur="this.parentElement.style.borderColor='rgba(255,255,255,0.09)'">
                            <button id="analysis-search-clear" style="background: transparent; border: none; color: #66758a; cursor: pointer; font-size: 16px; padding: 0; line-height: 1; opacity: 0.7;" title="Limpar">×</button>
                        </div>
                        <div id="analysis-search-results" style="display: none; position: absolute; left: 12px; right: 12px; top: calc(100%); max-height: 200px; overflow-y: auto; background: #101827; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; z-index: 100; box-shadow: 0 6px 20px rgba(0,0,0,0.6);"></div>
                    </div>
                    <div id="analysis-content">
                        ${htmlAnaliseVazia()}
                    </div>
                </div>

                <div
                    id="tab-comparacao"
                    class="tab-content"
                >
                    <div id="comparison-content">
                        <!-- Conteúdo da comparação será renderizado dinamicamente -->
                    </div>
                </div>

                <div
                    id="tab-captura"
                    class="tab-content"
                >
                    <div id="catch-analyzer-content">
                        <!-- Conteúdo da análise de captura será renderizado dinamicamente -->
                    </div>
                </div>



                <div class="footer">
                    Poke Idle World Tools
                </div>
            </div>
            <div id="resize-handle"></div>
        `;

        const estilo = document.createElement("style");
        estilo.textContent = criarCSS();

        document.head.appendChild(estilo);
        document.body.appendChild(painel);

        const movesPanel = document.createElement("div");
        movesPanel.id = "moves-panel";
        movesPanel.style.display = "none";
        document.body.appendChild(movesPanel);

        const itemsPanel = document.createElement("div");
        itemsPanel.id = "items-panel";
        itemsPanel.style.display = "none";
        document.body.appendChild(itemsPanel);

        restaurarEstadoPainel(painel);
        atualizarBotaoMinimizar(painel);
        ativarArraste(painel);
        ativarRedimensionamento(painel);
        trocarAba(abaAtual);
        limitarPainelNaTela(painel);

        document
            .getElementById("minimize")
            .addEventListener("click", evento => {
                evento.stopPropagation();
                alternarMinimizado(painel);
            });

        document
            .getElementById("close")
            .addEventListener("click", evento => {
                evento.stopPropagation();
                painel.style.display = "none";
                const movesPanelEl = document.getElementById("moves-panel");
                if (movesPanelEl) movesPanelEl.style.display = "none";
                mostrarAbaMoves = false;
                const btnMoves = document.querySelector('[data-tab="moves"]');
                if (btnMoves) btnMoves.classList.remove("active");

                const btnMovesHeader = document.getElementById("toggle-moves");
                if (btnMovesHeader) {
                    btnMovesHeader.style.opacity = "1";
                    btnMovesHeader.style.background = "";
                    btnMovesHeader.style.border = "";
                }

                const itemsPanelEl = document.getElementById("items-panel");
                if (itemsPanelEl) itemsPanelEl.style.display = "none";
                mostrarAbaItens = false;
                const btnItems = document.getElementById("toggle-items");
                if (btnItems) {
                    btnItems.style.opacity = "1";
                    btnItems.style.background = "";
                    btnItems.style.border = "";
                }
            });

        const btnMoves = document.getElementById("toggle-moves");
        if (btnMoves) {
            btnMoves.addEventListener("click", evento => {
                evento.stopPropagation();
                alternarPainelMoves();
            });
        }

        const btnItems = document.getElementById("toggle-items");
        if (btnItems) {
            btnItems.addEventListener("click", evento => {
                evento.stopPropagation();
                alternarPainelItens();
            });
        }

        const btnShiny = document.getElementById("toggle-shiny");
        const btnDaily = document.getElementById("toggle-daily");

        if (btnShiny) {
            btnShiny.addEventListener("click", evento => {
                evento.stopPropagation();
                shinyDetectorEnabled = !shinyDetectorEnabled;
                try {
                    localStorage.setItem("justpokedex-shiny-enabled", String(shinyDetectorEnabled));
                } catch (e) { }
                atualizarBotoesTopBanners();
            });
        }

        if (btnDaily) {
            btnDaily.addEventListener("click", evento => {
                evento.stopPropagation();
                dailyGiftEnabled = !dailyGiftEnabled;
                try {
                    localStorage.setItem("justpokedex-daily-enabled", String(dailyGiftEnabled));
                } catch (e) { }
                atualizarBotoesTopBanners();
            });
        }

        atualizarBotoesTopBanners();

        const btnTracking = document.getElementById("toggle-tracking");
        function atualizarEstiloTracking() {
            if (!btnTracking) return;
            if (mouseTrackingEnabled) {
                btnTracking.style.opacity = "1";
                btnTracking.title = "Leitura com Mouse: ATIVADA (Clique para Desativar)";
            } else {
                btnTracking.style.opacity = "0.4";
                btnTracking.title = "Leitura com Mouse: DESATIVADA (Clique para Ativar)";
            }
        }
        if (btnTracking) {
            atualizarEstiloTracking();
            btnTracking.addEventListener("click", evento => {
                evento.stopPropagation();
                mouseTrackingEnabled = !mouseTrackingEnabled;
                localStorage.setItem("pokemon-reader-tracking", mouseTrackingEnabled);
                atualizarEstiloTracking();
            });
        }

        document
            .getElementById("copy")
            .addEventListener("click", copiarTexto);

        document
            .getElementById("json")
            .addEventListener("click", copiarJson);

        document
            .getElementById("fix")
            .addEventListener("click", () => {
                if (!ultimoPokemon) return;
                const isFixed = pokemonFixado &&
                    normalizarNomePokemon(pokemonFixado.nome) === normalizarNomePokemon(ultimoPokemon.nome) &&
                    pokemonFixado.nivel === ultimoPokemon.nivel &&
                    pokemonFixado.poder === ultimoPokemon.poder;
                if (isFixed) {
                    desfixarPokemon();
                } else {
                    fixarPokemon(ultimoPokemon);
                }
            });

        document
            .querySelectorAll(".tab-button")
            .forEach(botao => {
                botao.addEventListener("click", () => {
                    trocarAba(botao.dataset.tab);
                });
            });

        // Debounce helper
        let searchDebounce = null;

        const searchInput = document.getElementById("analysis-search-input");
        const searchResults = document.getElementById("analysis-search-results");
        const searchClear = document.getElementById("analysis-search-clear");

        if (searchInput && searchResults) {
            searchInput.addEventListener("input", () => {
                clearTimeout(searchDebounce);
                const query = searchInput.value.trim().toLowerCase();
                if (query.length < 1) {
                    searchResults.style.display = "none";
                    searchResults.innerHTML = "";
                    return;
                }
                searchDebounce = setTimeout(async () => {
                    searchResults.style.display = "block";
                    searchResults.innerHTML = `<div style="padding: 10px 12px; color: #66758a; font-size: 11px;">Buscando...</div>`;
                    try {
                        const url = `https://pokeapi.co/api/v2/pokemon?limit=1302&offset=0`;
                        let lista = window._piwPokeList;
                        if (!lista) {
                            const resp = await fetch(url);
                            const data = await resp.json();
                            window._piwPokeList = data.results;
                            lista = data.results;
                        }
                        const matches = lista
                            .filter(p => p.name.includes(query))
                            .slice(0, 15);
                        if (matches.length === 0) {
                            searchResults.innerHTML = `<div style="padding: 10px 12px; color: #66758a; font-size: 11px;">Nenhum Pokémon encontrado.</div>`;
                            return;
                        }
                        searchResults.innerHTML = matches.map(p => {
                            const speciesId = p.url.split("/").filter(Boolean).pop();
                            const spriteUrl = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${speciesId}.png`;
                            const label = p.name.charAt(0).toUpperCase() + p.name.slice(1);
                            return `<div class="search-result-item" data-name="${p.name}" style="display: flex; align-items: center; gap: 10px; padding: 6px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.1s;">
                                <img src="${spriteUrl}" onerror="this.style.display='none'" style="width:28px;height:28px;object-fit:contain;image-rendering:pixelated;">
                                <span style="color: #e2ecfa; font-size: 11px; font-weight: bold;">${label}</span>
                                <span style="color: #66758a; font-size: 9px; margin-left:auto;">#${speciesId}</span>
                            </div>`;
                        }).join("");

                        searchResults.querySelectorAll(".search-result-item").forEach(item => {
                            item.addEventListener("mouseenter", () => { item.style.background = "rgba(255,255,255,0.06)"; });
                            item.addEventListener("mouseleave", () => { item.style.background = ""; });
                            item.addEventListener("click", async () => {
                                const pokeName = item.dataset.name;
                                searchInput.value = pokeName.charAt(0).toUpperCase() + pokeName.slice(1);
                                searchResults.style.display = "none";
                                const area = document.getElementById("analysis-content");
                                if (area) {
                                    area.innerHTML = `<div class="loading"><div class="loading-ball"><span></span></div><strong>Carregando dados...</strong></div>`;
                                }
                                try {
                                    const bases = await buscarAtributosBase(pokeName);
                                    const pokemonManual = {
                                        nome: pokeName.charAt(0).toUpperCase() + pokeName.slice(1),
                                        nivel: 1,
                                        tipos: bases.tipos || [],
                                        multiplicadorQualidade: 1.0,
                                        hp: null, atk: null, def: null,
                                        spa: null, spd: null, vel: null,
                                        ivAtual: null, ivMaximo: 192,
                                        poder: null, qualidade: null,
                                        ativo: false,
                                        _manual: true
                                    };
                                    renderizarFormularioAnalise(pokemonManual, bases);
                                } catch (err) {
                                    const area2 = document.getElementById("analysis-content");
                                    if (area2) area2.innerHTML = `<div class="warning"><strong>Pokémon não encontrado</strong><span>${escapeHtml(pokeName)}</span></div>`;
                                }
                            });
                        });
                    } catch (err) {
                        searchResults.innerHTML = `<div style="padding: 10px 12px; color: #f87171; font-size: 11px;">Erro ao buscar lista de Pokémon.</div>`;
                    }
                }, 300);
            });

            searchInput.addEventListener("keydown", e => {
                if (e.key === "Escape") {
                    searchResults.style.display = "none";
                    searchResults.innerHTML = "";
                }
            });

            document.addEventListener("click", e => {
                if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
                    searchResults.style.display = "none";
                }
            });
        }

        if (searchClear) {
            searchClear.addEventListener("click", () => {
                if (searchInput) searchInput.value = "";
                if (searchResults) {
                    searchResults.style.display = "none";
                    searchResults.innerHTML = "";
                }
            });
        }
    }

    function trocarAba(nome) {
        if (nome === "moves") {
            alternarPainelMoves();
            return;
        }

        if (
            nome !== "leitor" &&
            nome !== "analise" &&
            nome !== "comparacao" &&
            nome !== "captura"
        ) {
            return;
        }

        abaAtual = nome;

        document
            .querySelectorAll(".tab-button")
            .forEach(botao => {
                if (botao.dataset.tab !== "moves") {
                    botao.classList.toggle(
                        "active",
                        botao.dataset.tab === nome
                    );
                }
            });

        document
            .querySelectorAll(".tab-content")
            .forEach(conteudo => {
                conteudo.classList.remove("active");
            });

        document
            .getElementById(`tab-${nome}`)
            ?.classList.add("active");

        const painel =
            document.getElementById(CONFIG.panelId);

        if (painel) {
            limitarPainelNaTela(painel);
            salvarEstadoPainel(painel);
        }

        if (nome === "comparacao") {
            atualizarPainelComparacao();
        }

        if (nome === "captura") {
            if (typeof renderizarAbaCaptura === "function") {
                renderizarAbaCaptura();
            }
        }
    }

    function adicionarAoHistorico(pokemon) {
        if (!pokemon) return;
        const index = historicoPokemon.findIndex(p =>
            normalizarNomePokemon(p.nome) === normalizarNomePokemon(pokemon.nome) &&
            p.nivel === pokemon.nivel &&
            p.poder === pokemon.poder
        );
        if (index !== -1) {
            historicoPokemon.splice(index, 1);
        }
        historicoPokemon.unshift({ ...pokemon });
        if (historicoPokemon.length > 10) {
            historicoPokemon.pop();
        }
        try {
            localStorage.setItem("pokemon-reader-history", JSON.stringify(historicoPokemon));
        } catch (e) { }
    }

    function carregarPokemonDoHistorico(pokemon) {
        ultimoPokemon = pokemon;
        ultimoTexto = `HIST-${pokemon.nome}-${pokemon.nivel}-${pokemon.poder}`;
        atualizarPainelLeitor(pokemon);
        carregarAnalise(pokemon);
        atualizarPainelMoves();
        atualizarPosicaoPainelMoves();
        atualizarPosicaoPainelItens();
        atualizarPainelComparacao();
    }

    function atualizarPainelLeitor(pokemon) {
        adicionarAoHistorico(pokemon);

        const conteudo =
            document.getElementById("content");

        const painel =
            document.getElementById(CONFIG.panelId);

        if (!conteudo || !painel) return;

        mostrarPainelCompleto();

        const ivPercentual =
            pokemon.ivAtual !== null &&
                pokemon.ivMaximo
                ? (
                    (
                        pokemon.ivAtual /
                        pokemon.ivMaximo
                    ) * 100
                ).toFixed(1)
                : null;

        const nomeNormalizado = normalizarNomePokemon(pokemon.nome);
        const cacheInfo = apiCache[nomeNormalizado];
        let htmlSprite = "";

        if (cacheInfo && cacheInfo.id) {
            const shiny = isShiny(pokemon);
            const urls = obterUrlsSprite(cacheInfo.id, shiny);
            htmlSprite = `<img class="sprite" src="${urls.anim}" data-fallback="${urls.still}" onerror="${SPRITE_ONERROR}" alt="${escapeHtml(pokemon.nome)}">`;
        } else {
            htmlSprite = `<div class="loading-ball-mini" style="width: 24px; height: 24px; border: 1.5px solid #171717; border-radius: 50%; background: linear-gradient(to bottom, #f34848 0%, #f34848 43%, #151515 43%, #151515 57%, #f7f7f7 57%); animation: spin 1.1s linear infinite; position: relative;"><span style="position: absolute; top: 50%; left: 50%; width: 6px; height: 6px; border: 1px solid #171717; border-radius: 50%; background: #fff; transform: translate(-50%, -50%);"></span></div>`;

            buscarAtributosBase(pokemon.nome).then(() => {
                if (ultimoPokemon && normalizarNomePokemon(ultimoPokemon.nome) === nomeNormalizado) {
                    atualizarPainelLeitor(ultimoPokemon);
                }
            }).catch(() => { });
        }

        const chipsTipos = pokemon.tipos
            .map(tipo => `
                <span class="type-chip">
                    ${escapeHtml(tipo)}
                </span>
            `)
            .join("");

        const chipAtivo = pokemon.ativo
            ? `
                <span
                    class="type-chip active-chip"
                >
                    ⚔ Ativo
                </span>
            `
            : "";

        const maxStatValue = Math.max(
            pokemon.hp || 0,
            pokemon.atk || 0,
            pokemon.def || 0,
            pokemon.spa || 0,
            pokemon.spd || 0,
            pokemon.vel || 0,
            1
        );

        function renderCardStat(label, val, cor) {
            if (val === null || val === undefined) return "";
            const percent = Math.max(4, Math.min(100, (val / maxStatValue) * 100));
            return `
                <div class="display-stat-card" style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    background: linear-gradient(135deg, #151d2a 0%, #0d141e 100%);
                    border: 1px solid rgba(255,255,255,0.06);
                    border-top: 3px solid ${cor};
                    border-radius: 8px;
                    padding: 6px;
                    gap: 3px;
                    box-sizing: border-box;
                ">
                    <span style="color: ${cor}; font-size: 8px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">${label}</span>
                    <strong style="color: #fff; font-size: 13px; font-weight: bold; line-height: 1.2;">${val}</strong>
                    <div style="width: 100%; height: 3px; background: rgba(255,255,255,0.06); border-radius: 9px; overflow: hidden; margin-top: 2px;">
                        <div style="height: 100%; background: ${cor}; width: ${percent}%;"></div>
                    </div>
                </div>
            `;
        }

        const htmlQualidade = pokemon.qualidade ? `
            <div style="background: linear-gradient(135deg, #18202d 0%, #0e1622 100%); border: 1px solid rgba(241,198,68,0.15); border-radius: 8px; padding: 5px 4px; display: flex; flex-direction: column; gap: 1px; min-width: 0; text-align: center;">
                <span style="color: #ca9e00; font-size: 7px; font-weight: bold; letter-spacing: 0.3px; text-transform: uppercase;">Qualidade</span>
                <strong style="color: #f1c644; font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(pokemon.qualidade)}</strong>
            </div>
        ` : "";

        const htmlIV = pokemon.ivAtual !== null ? `
            <div style="background: linear-gradient(135deg, #18202d 0%, #0e1622 100%); border: 1px solid rgba(85,230,211,0.15); border-radius: 8px; padding: 5px 4px; display: flex; flex-direction: column; gap: 1px; min-width: 0; text-align: center;">
                <span style="color: #00bcd4; font-size: 7px; font-weight: bold; letter-spacing: 0.3px; text-transform: uppercase;">IV Total</span>
                <strong style="color: #55e6d3; font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${pokemon.ivAtual}/${pokemon.ivMaximo} (${ivPercentual}%)">${pokemon.ivAtual}/${pokemon.ivMaximo} (${ivPercentual}%)</strong>
            </div>
        ` : "";

        const htmlPoder = (pokemon.poder !== null && pokemon.poder !== undefined) ? `
            <div style="background: linear-gradient(135deg, #18202d 0%, #0e1622 100%); border: 1px solid rgba(255,152,0,0.15); border-radius: 8px; padding: 5px 4px; display: flex; flex-direction: column; gap: 1px; min-width: 0; text-align: center;">
                <span style="color: #ff9800; font-size: 7px; font-weight: bold; letter-spacing: 0.3px; text-transform: uppercase;">Poder Total</span>
                <strong style="color: #ffb74d; font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">⚡ ${formatarNumero(pokemon.poder)}</strong>
            </div>
        ` : "";

        conteudo.innerHTML = `
            <div class="pokemon-card">
                <div class="pokemon-top" style="display: flex; gap: 12px; align-items: center; padding: 12px;">
                    <div class="sprite-container" style="flex: 0 0 64px; height: 64px; display: grid; place-items: center; background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0.2) 100%); border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); overflow: hidden;">
                        ${htmlSprite}
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div class="name-line" style="display: flex; align-items: center; justify-content: space-between; gap: 4px;">
                            <div class="name" style="font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 130px; font-weight: bold; color: #fff;">
                                ${escapeHtml(pokemon.nome)}
                            </div>

                            <div class="level-badge" style="background: rgba(202,48,53,0.15); border: 1px solid rgba(202,48,53,0.3); border-radius: 4px; padding: 2px 6px; font-size: 9px; font-weight: bold; color: #ff767b; white-space: nowrap;">
                                Nv ${escapeHtml(pokemon.nivel ?? "-")}
                            </div>
                        </div>

                        <div class="types" style="display: flex; align-items: center; justify-content: space-between; width: 100%; margin-top: 4px;">
                            <div style="display: flex; gap: 4px; flex-wrap: wrap; align-items: center;">
                                ${chipsTipos}
                                ${chipAtivo}
                            </div>
                            <button id="btn-historico" type="button" style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: #8795aa; cursor: pointer; font-size: 10px; display: flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 4px; font-weight: bold; outline: none; transition: all 0.15s ease;" onmouseenter="this.style.background='rgba(255,255,255,0.08)';this.style.color='#fff';" onmouseleave="this.style.background='rgba(255,255,255,0.04)';this.style.color='#8795aa';" title="Histórico de Análises">
                                🕒 Histórico
                            </button>
                        </div>
                    </div>
                </div>

                <div class="info-area" style="padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px;">
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;">
                        ${htmlQualidade}
                        ${htmlIV}
                        ${htmlPoder}
                    </div>

                    <div class="stats-display-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 4px;">
                        ${renderCardStat("HP", pokemon.hp, "#4caf50")}
                        ${renderCardStat("Atk", pokemon.atk, "#ff9800")}
                        ${renderCardStat("Def", pokemon.def, "#ffeb3b")}
                        ${renderCardStat("SpA", pokemon.spa, "#2196f3")}
                        ${renderCardStat("SpD", pokemon.spd, "#00bcd4")}
                        ${renderCardStat("Vel", pokemon.vel, "#e91e63")}
                    </div>

                    <a href="${gerarUrlPIWTools(pokemon)}" target="_blank" rel="noopener noreferrer" style="
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        margin-top: 4px;
                        padding: 7px 12px;
                        background: linear-gradient(135deg, rgba(85,230,211,0.12) 0%, rgba(28,232,205,0.04) 100%);
                        border: 1px solid rgba(85,230,211,0.25);
                        border-radius: 8px;
                        color: #55e6d3;
                        font-size: 11px;
                        font-weight: bold;
                        text-decoration: none;
                        transition: all 0.2s ease;
                        box-shadow: 0 2px 6px rgba(0,0,0,0.15);
                    " onmouseenter="this.style.background='linear-gradient(135deg, rgba(85,230,211,0.2) 0%, rgba(28,232,205,0.08) 100%)';this.style.borderColor='rgba(85,230,211,0.45)';" onmouseleave="this.style.background='linear-gradient(135deg, rgba(85,230,211,0.12) 0%, rgba(28,232,205,0.04) 100%)';this.style.borderColor='rgba(85,230,211,0.25)';">
                        🌐 <span>Simular Rota no PIW Tools</span>
                        <span style="font-size: 10px; opacity: 0.8; margin-left: auto;">↗</span>
                    </a>

                    ${obterEfetividadeHtml(pokemon)}
                </div>
            </div>
        `;

        limitarPainelNaTela(painel);
        atualizarBotoesFixar();

        // Configuração de Event Listeners do histórico
        const btnHist = document.getElementById("btn-historico");
        if (btnHist) {
            btnHist.addEventListener("click", (e) => {
                e.stopPropagation();
                let popup = document.getElementById("historico-popup");
                if (popup) {
                    popup.remove();
                    return;
                }

                popup = document.createElement("div");
                popup.id = "historico-popup";
                popup.style.position = "absolute";
                popup.style.left = "12px";
                popup.style.right = "12px";
                popup.style.top = "105px";
                popup.style.background = "#101827";
                popup.style.border = "1px solid rgba(255,255,255,0.12)";
                popup.style.borderRadius = "8px";
                popup.style.zIndex = "1000";
                popup.style.boxShadow = "0 6px 20px rgba(0,0,0,0.6)";
                popup.style.padding = "6px 0";

                const items = historicoPokemon.filter(p =>
                    !(normalizarNomePokemon(p.nome) === normalizarNomePokemon(pokemon.nome) &&
                        p.nivel === pokemon.nivel &&
                        p.poder === pokemon.poder)
                ).slice(0, 3);

                if (items.length === 0) {
                    popup.innerHTML = `<div style="padding: 10px 12px; color: #66758a; font-size: 11px; text-align: center;">Nenhum histórico disponível.</div>`;
                } else {
                    popup.innerHTML = items.map((p, idx) => {
                        const nomeNorm = normalizarNomePokemon(p.nome);
                        const cache = apiCache[nomeNorm];
                        const spriteUrl = cache && cache.id
                            ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${cache.id}.png`
                            : "";
                        const ivPercent = p.ivAtual !== null && p.ivMaximo
                            ? `${((p.ivAtual / p.ivMaximo) * 100).toFixed(1)}%`
                            : "-";

                        return `
                            <div class="historico-item" data-idx="${idx}" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; border-bottom: ${idx < items.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none'}; transition: background 0.1s;">
                                ${spriteUrl ? `<img src="${spriteUrl}" style="width:24px;height:24px;object-fit:contain;image-rendering:pixelated;">` : `<span style="font-size:14px;width:24px;text-align:center;">◉</span>`}
                                <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                                    <strong style="color: #fff; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(p.nome)}</strong>
                                    <span style="color: #66758a; font-size: 8px;">Nv ${p.nivel} • IV: ${p.ivAtual !== null ? p.ivAtual : '-'}/${p.ivMaximo || 192} (${ivPercent})</span>
                                </div>
                                <span style="color: #66758a; font-size: 9px; margin-left: auto;">›</span>
                            </div>
                        `;
                    }).join("");

                    popup.querySelectorAll(".historico-item").forEach(itemEl => {
                        itemEl.addEventListener("mouseenter", () => { itemEl.style.background = "rgba(255,255,255,0.06)"; });
                        itemEl.addEventListener("mouseleave", () => { itemEl.style.background = ""; });
                        itemEl.addEventListener("click", () => {
                            const indexInFilter = parseInt(itemEl.dataset.idx);
                            const selected = items[indexInFilter];
                            carregarPokemonDoHistorico(selected);
                            popup.remove();
                        });
                    });
                }

                const tabLeitor = document.getElementById("tab-leitor");
                if (tabLeitor) {
                    tabLeitor.appendChild(popup);
                }
            });

            document.addEventListener("click", (e) => {
                const popup = document.getElementById("historico-popup");
                if (popup && !popup.contains(e.target) && !btnHist.contains(e.target)) {
                    popup.remove();
                }
            });
        }
    }

    function obterIVsEstimados(pokemon, bases) {
        if (!pokemon || !bases) return null;

        const ivs = {};
        const nivel = pokemon.nivel;
        const qualidade = pokemon.multiplicadorQualidade ?? 1;

        for (const chave of Object.keys(CONFIG.expoentes)) {
            const atual = pokemon[chave];
            const baseVal = bases[chave];

            if (atual === null || atual === undefined || baseVal === null || baseVal === undefined) {
                ivs[chave] = 0;
            } else {
                ivs[chave] = estimarIVIndividual({
                    atributoAtual: atual,
                    atributoBase: baseVal,
                    nivel,
                    qualidade,
                    expoente: CONFIG.expoentes[chave]
                });
            }
        }
        return ivs;
    }

    function obterSomaIV(ivs) {
        if (!ivs) return 0;
        return arredondar(
            Object.values(ivs).reduce((soma, valor) => soma + (valor || 0), 0),
            1
        );
    }

    function fixarPokemon(pokemon) {
        if (!pokemon) return;
        pokemonFixado = { ...pokemon };
        localStorage.setItem("pokemon-fixed", JSON.stringify(pokemonFixado));
        atualizarBotoesFixar();
        atualizarPainelComparacao();
    }

    function desfixarPokemon() {
        pokemonFixado = null;
        localStorage.removeItem("pokemon-fixed");
        atualizarBotoesFixar();
        atualizarPainelComparacao();
    }

    function atualizarBotoesFixar() {
        const btnFix = document.getElementById("fix");
        if (!btnFix || !ultimoPokemon) return;

        const isFixed = pokemonFixado &&
            normalizarNomePokemon(pokemonFixado.nome) === normalizarNomePokemon(ultimoPokemon.nome) &&
            pokemonFixado.nivel === ultimoPokemon.nivel &&
            pokemonFixado.poder === ultimoPokemon.poder;

        if (isFixed) {
            btnFix.innerHTML = "📌 Desfixar";
            btnFix.style.background = "linear-gradient(#f4d65e, #cba52a)";
            btnFix.style.color = "#171717";
            btnFix.style.borderColor = "#ffe984";
        } else {
            btnFix.innerHTML = "📌 Fixar";
            btnFix.style.background = "linear-gradient(#4d5a75, #2e3b52)";
            btnFix.style.color = "#fff";
            btnFix.style.borderColor = "#5c6c8c";
        }
    }

    function renderLinhaComparacao(label, cor, valFix, valAti) {
        let diffIcon = "=";
        let diffColor = "#8795aa";

        const numFix = typeof valFix === "number" ? valFix : Number(String(valFix ?? 0).replace(/\./g, "").replace(",", "."));
        const numAti = typeof valAti === "number" ? valAti : Number(String(valAti ?? 0).replace(/\./g, "").replace(",", "."));

        if (numAti > numFix) {
            diffIcon = "▲";
            diffColor = "#4caf50";
        } else if (numAti < numFix) {
            diffIcon = "▼";
            diffColor = "#e91e63";
        }

        const dispFix = typeof valFix === "number" ? formatarDecimal(valFix, 1) : valFix;
        const dispAti = typeof valAti === "number" ? formatarDecimal(valAti, 1) : valAti;

        return `
            <div style="display: grid; grid-template-columns: 1.2fr 1fr 1fr 0.4fr; align-items: center; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); font-size: 11px;">
                <span style="color: ${cor}; font-weight: bold;">${label}</span>
                <span style="color: #cad6e7; text-align: center;">${dispFix}</span>
                <span style="color: #fff; text-align: center; font-weight: bold;">${dispAti}</span>
                <span style="color: ${diffColor}; font-weight: bold; text-align: right; font-size: 12px;">${diffIcon}</span>
            </div>
        `;
    }

    function atualizarPainelComparacao() {
        const area = document.getElementById("comparison-content");
        if (!area) return;

        if (!pokemonFixado) {
            area.innerHTML = `
                <div style="padding: 24px 16px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;">
                    <span style="font-size: 24px;">⚖</span>
                    <strong style="color: #cad6e7; font-size: 13px;">Nenhum Pokémon fixado</strong>
                    <span style="color: #6d7f96; font-size: 11px; line-height: 1.4; max-width: 220px;">
                        Vá na aba principal e clique em <strong>📌 Fixar</strong> para escolher o Pokémon base da comparação.
                    </span>
                </div>
            `;
            return;
        }

        const active = ultimoPokemon || pokemonFixado;

        const basesFix = apiCache[normalizarNomePokemon(pokemonFixado.nome)] || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, vel: 0 };
        const basesAct = apiCache[normalizarNomePokemon(active.nome)] || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, vel: 0 };

        const ivsFix = obterIVsEstimados(pokemonFixado, basesFix) || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, vel: 0 };
        const ivsAct = obterIVsEstimados(active, basesAct) || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, vel: 0 };

        const sumFix = obterSomaIV(ivsFix);
        const sumAct = obterSomaIV(ivsAct);

        const qualFix = pokemonFixado.multiplicadorQualidade ?? 1;
        const qualAct = active.multiplicadorQualidade ?? 1;

        const powerFix = pokemonFixado.poder ?? 0;
        const powerAct = active.poder ?? 0;

        area.innerHTML = `
            <div class="comparison-wrapper" style="padding: 10px; display: flex; flex-direction: column; gap: 8px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 4px;">
                    <div style="background: linear-gradient(135deg, #18202d 0%, #0e1622 100%); border: 1px solid rgba(241,198,68,0.15); border-radius: 8px; padding: 8px; text-align: center; position: relative;">
                        <span style="position: absolute; top: 4px; left: 6px; color: #ca9e00; font-size: 6px; font-weight: bold; text-transform: uppercase;">📌 Fixado</span>
                        <strong style="color: #fff; font-size: 12px; display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(pokemonFixado.nome)}</strong>
                        <span style="color: #8795aa; font-size: 9px; display: block; margin-top: 2px;">Nv ${pokemonFixado.nivel ?? "-"}</span>
                    </div>

                    <div style="background: linear-gradient(135deg, #18202d 0%, #0e1622 100%); border: 1px solid rgba(85,230,211,0.15); border-radius: 8px; padding: 8px; text-align: center; position: relative;">
                        <span style="position: absolute; top: 4px; left: 6px; color: #00bcd4; font-size: 6px; font-weight: bold; text-transform: uppercase;">⚔ Ativo</span>
                        <strong style="color: #fff; font-size: 12px; display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(active.nome)}</strong>
                        <span style="color: #8795aa; font-size: 9px; display: block; margin-top: 2px;">Nv ${active.nivel ?? "-"}</span>
                    </div>
                </div>

                <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; overflow: hidden;">
                    <div style="display: grid; grid-template-columns: 1.2fr 1fr 1fr 0.4fr; background: rgba(0,0,0,0.2); padding: 6px 12px; font-size: 8px; color: #8795aa; text-transform: uppercase; font-weight: bold; border-bottom: 1px solid rgba(255,255,255,0.06);">
                        <span>Status / IV</span>
                        <span style="text-align: center;">Fixado</span>
                        <span style="text-align: center;">Ativo</span>
                        <span style="text-align: right;">Diff</span>
                    </div>

                    ${renderLinhaComparacao("HP", "#4caf50", ivsFix.hp, ivsAct.hp)}
                    ${renderLinhaComparacao("Atk", "#ff9800", ivsFix.atk, ivsAct.atk)}
                    ${renderLinhaComparacao("Def", "#ffeb3b", ivsFix.def, ivsAct.def)}
                    ${renderLinhaComparacao("SpA", "#2196f3", ivsFix.spa, ivsAct.spa)}
                    ${renderLinhaComparacao("SpD", "#00bcd4", ivsFix.spd, ivsAct.spd)}
                    ${renderLinhaComparacao("Spe", "#e91e63", ivsFix.vel, ivsAct.vel)}
                    
                    ${renderLinhaComparacao("Σ IV", "#cad6e7", sumFix, sumAct)}
                    ${renderLinhaComparacao("Qualidade", "#f1c644", formatarDecimal(qualFix, 2), formatarDecimal(qualAct, 2))}
                    ${renderLinhaComparacao("Poder total", "#ffb35c", formatarNumero(powerFix), formatarNumero(powerAct))}
                </div>

                ${(() => {
                const order = ["hp", "atk", "def", "spa", "spd", "vel"];
                const basesFixArr = order.map(k => basesFix[k]);
                const ivsFixArr = order.map(k => ivsFix[k]);
                const potFix = calcularPotencialExemplar(basesFixArr, ivsFixArr, qualFix, CONFIG.maxIVIndividual);

                const basesActArr = order.map(k => basesAct[k]);
                const ivsActArr = order.map(k => ivsAct[k]);
                const potAct = calcularPotencialExemplar(basesActArr, ivsActArr, qualAct, CONFIG.maxIVIndividual);
                const classFix = classificarPotencial(potFix);
                const classAct = classificarPotencial(potAct);
                const diffPot = arredondar(potAct - potFix, 1);
                const diffIcon = diffPot > 0 ? "▲" : diffPot < 0 ? "▼" : "=";
                const diffColor = diffPot > 0 ? "#4caf50" : diffPot < 0 ? "#e91e63" : "#8795aa";

                return `
                        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; overflow: hidden;">
                            <div style="background: rgba(0,0,0,0.2); padding: 6px 12px; font-size: 8px; color: #8795aa; text-transform: uppercase; font-weight: bold; border-bottom: 1px solid rgba(255,255,255,0.06);">
                                ⭐ Potencial do exemplar
                            </div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: rgba(255,255,255,0.04);">
                                <div style="background: #0d1420; padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 4px;">
                                    <span style="color: #ca9e00; font-size: 7px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">📌 Fixado</span>
                                    <strong style="color: ${classFix.cor}; font-size: 22px; line-height: 1;">${formatarDecimal(potFix, 1)}%</strong>
                                    <span style="color: ${classFix.cor}; font-size: 9px; font-weight: bold; padding: 2px 7px; background: ${classFix.cor}18; border: 1px solid ${classFix.cor}33; border-radius: 99px;">${classFix.texto}</span>
                                </div>
                                <div style="background: #0d1420; padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 4px; position: relative;">
                                    <span style="color: #00bcd4; font-size: 7px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">⚔ Ativo</span>
                                    <strong style="color: ${classAct.cor}; font-size: 22px; line-height: 1;">${formatarDecimal(potAct, 1)}%</strong>
                                    <span style="color: ${classAct.cor}; font-size: 9px; font-weight: bold; padding: 2px 7px; background: ${classAct.cor}18; border: 1px solid ${classAct.cor}33; border-radius: 99px;">${classAct.texto}</span>
                                    <span style="position: absolute; top: 8px; right: 10px; color: ${diffColor}; font-weight: bold; font-size: 13px;">${diffIcon}</span>
                                </div>
                            </div>
                            <div style="padding: 8px 12px; background: rgba(0,0,0,0.15); border-top: 1px solid rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: space-between;">
                                <span style="color: #8795aa; font-size: 9px;">Diferença de potencial</span>
                                <span style="color: ${diffColor}; font-weight: bold; font-size: 11px;">${diffPot > 0 ? "+" : ""}${formatarDecimal(diffPot, 1)}%</span>
                            </div>
                        </div>
                    `;
            })()}
            </div>
        `;
    }

    async function buscarAtributosBase(nome) {
        const nomeNormalizado =
            normalizarNomePokemon(nome);

        if (!nomeNormalizado) {
            throw new Error(
                "Nome do Pokémon inválido."
            );
        }

        if (apiCache[nomeNormalizado]) {
            return apiCache[nomeNormalizado];
        }

        const nomeBrutoLimpo = String(nome || "").toLowerCase().trim();
        if (apiCache[nomeBrutoLimpo]) {
            return apiCache[nomeBrutoLimpo];
        }

        let resposta = await fetch(
            `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(nomeNormalizado)}`
        );

        // Fallback 1: Nidoran Male / Female especificamente
        if (!resposta.ok) {
            const raw = String(nome || "").toLowerCase();
            if (raw.includes("nidoran") && (raw.includes("male") || raw.includes("m"))) {
                resposta = await fetch(`https://pokeapi.co/api/v2/pokemon/nidoran-m`);
            } else if (raw.includes("nidoran") && (raw.includes("female") || raw.includes("f"))) {
                resposta = await fetch(`https://pokeapi.co/api/v2/pokemon/nidoran-f`);
            }
        }

        // Fallback 2: Se o nome normalizado falhar (404) e tiver hífen, tenta buscar pelo primeiro termo (nome base da espécie)
        if (!resposta.ok && nomeNormalizado.includes("-")) {
            const primeiroNome = nomeNormalizado.split("-")[0];
            if (primeiroNome && primeiroNome !== nomeNormalizado) {
                resposta = await fetch(
                    `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(primeiroNome)}`
                );
            }
        }

        if (!resposta.ok) {
            throw new Error(
                `Pokémon não encontrado: ${nome}`
            );
        }

        const dados = await resposta.json();
        const mapa = {};

        for (const item of dados.stats || []) {
            mapa[item.stat.name] = item.base_stat;
        }

        const TRANSLATE_TYPES = {
            normal: "Normal",
            fighting: "Lutador",
            flying: "Voador",
            poison: "Veneno",
            ground: "Terra",
            rock: "Pedra",
            bug: "Inseto",
            ghost: "Fantasma",
            steel: "Aço",
            fire: "Fogo",
            water: "Água",
            grass: "Planta",
            electric: "Elétrico",
            psychic: "Psíquico",
            ice: "Gelo",
            dragon: "Dragão",
            dark: "Sombrio",
            fairy: "Fada"
        };

        const tiposEn = (dados.types || []).map(t => t.type.name);
        const tiposPt = tiposEn.map(t => TRANSLATE_TYPES[t] || (t.charAt(0).toUpperCase() + t.slice(1)));

        const info = {
            id: dados.id,
            hp: mapa.hp ?? null,
            atk: mapa.attack ?? null,
            def: mapa.defense ?? null,
            spa: mapa["special-attack"] ?? null,
            spd: mapa["special-defense"] ?? null,
            vel: mapa.speed ?? null,
            tipos: tiposPt
        };

        apiCache[nomeNormalizado] = info;
        salvarCache();

        return info;
    }

    async function carregarAnalise(pokemon) {
        const area =
            document.getElementById(
                "analysis-content"
            );

        if (!area) return;

        area.innerHTML = `
            <div class="loading">
                <div class="loading-ball">
                    <span></span>
                </div>

                <strong>
                    Preparando análise
                </strong>

                <span>
                    Buscando os atributos-base de
                    ${escapeHtml(pokemon.nome)}...
                </span>
            </div>
        `;

        const idConsulta =
            `${pokemon.nome}-${Date.now()}`;

        consultaEmAndamento = idConsulta;

        try {
            const bases =
                await buscarAtributosBase(
                    pokemon.nome
                );

            if (
                consultaEmAndamento !== idConsulta
            ) {
                return;
            }

            renderizarFormularioAnalise(
                pokemon,
                bases
            );
            atualizarPainelComparacao();
        } catch (erro) {
            console.warn(
                "[Poké Leitor] Falha ao buscar atributos-base.",
                erro
            );

            if (
                consultaEmAndamento !== idConsulta
            ) {
                return;
            }

            renderizarFormularioAnalise(
                pokemon,
                {
                    hp: 0,
                    atk: 0,
                    def: 0,
                    spa: 0,
                    spd: 0,
                    vel: 0
                },
                erro.message
            );
            atualizarPainelComparacao();
        }
    }

    function renderizarFormularioAnalise(
        pokemon,
        bases,
        aviso = ""
    ) {
        const area =
            document.getElementById(
                "analysis-content"
            );

        if (!area) return;

        // Registra se é um pokémon de análise manual (sem hover)
        if (pokemon._manual) {
            pokemonManualAtual = pokemon;
        } else {
            pokemonManualAtual = null;
        }

        const tipos = pokemon.tipos
            .map(tipo => `
                <span>${escapeHtml(tipo)}</span>
            `)
            .join("");

        const nomeNormalizado = normalizarNomePokemon(pokemon.nome);
        const cacheInfo = apiCache[nomeNormalizado];
        let htmlSpriteAnalysis = "<span>IV</span>";

        if (cacheInfo && cacheInfo.id) {
            const shiny = isShiny(pokemon);
            const urls = obterUrlsSprite(cacheInfo.id, shiny);
            htmlSpriteAnalysis = `<img class="sprite" src="${urls.anim}" data-fallback="${urls.still}" onerror="${SPRITE_ONERROR}" alt="${escapeHtml(pokemon.nome)}">`;
        }

        area.innerHTML = `
            <div class="analysis-hero">
                <div class="analysis-hero-pattern"></div>

                <div class="analysis-pokemon-icon" style="overflow: hidden; display: grid; place-items: center;">
                    ${htmlSpriteAnalysis}
                </div>

                <div class="analysis-identity">
                    <small>ANALISANDO</small>

                    <strong>
                        ${escapeHtml(pokemon.nome)}
                    </strong>

                    <div class="analysis-types">
                        ${tipos}
                    </div>

                    <div class="analysis-results-mini" id="analysis-results-mini" style="display: none; align-items: center; gap: 4px; margin-top: 6px; flex-wrap: nowrap;">
                        <span class="mini-badge quality" style="padding: 2px 4px; background: rgba(241,198,68,0.08); border: 1px solid rgba(241,198,68,0.25); border-radius: 4px; font-size: 8px; font-weight: bold; color: #f1c644; display: flex; align-items: center; gap: 2px; white-space: nowrap;">
                            Q: <span id="mini-val-quality">-</span>
                        </span>
                        <span class="mini-badge iv" style="padding: 2px 4px; background: rgba(85,230,211,0.08); border: 1px solid rgba(85,230,211,0.25); border-radius: 4px; font-size: 8px; font-weight: bold; color: #55e6d3; display: flex; align-items: center; gap: 2px; white-space: nowrap;">
                            IV: <span id="mini-val-iv">-</span>
                        </span>
                        <span class="mini-badge power" style="padding: 2px 4px; background: rgba(255,179,92,0.08); border: 1px solid rgba(255,179,92,0.25); border-radius: 4px; font-size: 8px; font-weight: bold; color: #ffb35c; display: flex; align-items: center; gap: 2px; white-space: nowrap;">
                            ⚡ <span id="mini-val-power">-</span>
                        </span>
                    </div>
                </div>

                <div class="analysis-level">
                    <small>NÍVEL</small>
                    <b id="hero-nivel-val">${escapeHtml(String(pokemon.nivel ?? "-"))}</b>
                </div>
            </div>

            <div style="padding: 0 12px; margin-top: 8px;">
                <a id="btn-piw-tools-analise" href="${gerarUrlPIWTools(pokemon)}" target="_blank" rel="noopener noreferrer" style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    padding: 7px 12px;
                    background: linear-gradient(135deg, rgba(85,230,211,0.12) 0%, rgba(28,232,205,0.04) 100%);
                    border: 1px solid rgba(85,230,211,0.25);
                    border-radius: 8px;
                    color: #55e6d3;
                    font-size: 11px;
                    font-weight: bold;
                    text-decoration: none;
                    transition: all 0.2s ease;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.15);
                " onmouseenter="this.style.background='linear-gradient(135deg, rgba(85,230,211,0.2) 0%, rgba(28,232,205,0.08) 100%)';this.style.borderColor='rgba(85,230,211,0.45)';" onmouseleave="this.style.background='linear-gradient(135deg, rgba(85,230,211,0.12) 0%, rgba(28,232,205,0.04) 100%)';this.style.borderColor='rgba(85,230,211,0.25)';">
                    <span style="font-size: 13px;">🌐</span>
                    <span>Simular Rota no PIW Tools</span>
                </a>
            </div>

            ${pokemon.nivel && pokemon.nivel < 15
                ? `
                        <div class="warning level-warning" style="margin: 8px 12px; padding: 8px 10px; background: rgba(243, 154, 75, 0.15); border: 1px solid rgba(243, 154, 75, 0.4); border-radius: 8px; color: #ffd77d; font-size: 10px; display: flex; align-items: center; gap: 6px;">
                            <span style="font-size: 14px;">⚠️</span>
                            <div>
                                <strong style="color: #ffd77d; font-size: 10px;">Atenção: Nível abaixo do Nv. 15</strong>
                                <span style="display: block; font-size: 9px; color: #e2b069; margin-top: 1px;">Para o cálculo de IV ser preciso, o Pokémon precisa estar no Nv. 15 ou superior.</span>
                            </div>
                        </div>
                    `
                : ""
            }

            ${aviso
                ? `
                        <div class="warning">
                            <strong>⚠ Dados-base não encontrados</strong>

                            <span>
                                Preencha manualmente os
                                atributos-base abaixo.
                            </span>
                        </div>
                    `
                : ""
            }

            <div class="analysis-toolbar">
                <div>
                    <strong>Dados do cálculo</strong>

                    <span>
                        Confira ou ajuste os valores
                    </span>
                </div>

                <button
                    id="toggle-form"
                    type="button"
                >
                    ${formularioRecolhido
                ? "Mostrar"
                : "Recolher"
            }
                </button>
            </div>

            <div
                id="analysis-form"
                class="${formularioRecolhido
                ? "form-collapsed"
                : ""
            }"
            >
                <div class="primary-fields">
                    <label class="primary-field">
                        <span>
                            <i>◆</i>
                            Qualidade
                        </span>

                        <div class="input-with-suffix">
                            <input
                                id="quality-input"
                                type="number"
                                min="1"
                                max="4"
                                step="0.01"
                                value="${pokemon.multiplicadorQualidade ?? ""}"
                            >

                            <b>×</b>
                        </div>
                    </label>

                    <label class="primary-field">
                        <span>
                            <i>★</i>
                            Nível
                        </span>

                        <div class="input-with-suffix">
                            <input
                                id="level-input"
                                type="number"
                                min="1"
                                max="9999"
                                step="1"
                                value="${pokemon.nivel ?? ""}"
                            >

                            <b>Nv</b>
                        </div>
                    </label>

                    <label class="primary-field">
                        <span>
                            <i>✦</i>
                            IV Total
                        </span>

                        <div class="input-with-suffix">
                            <input
                                id="iv-total-input"
                                type="number"
                                min="0"
                                max="192"
                                step="0.1"
                                placeholder="${pokemon.ivAtual ?? ''}"
                                value="${pokemon.ivAtual ?? ''}"
                            >

                            <b>/192</b>
                        </div>
                    </label>
                </div>

                <div class="data-section">
                    <div class="data-section-heading" style="margin-bottom: 10px;">
                        <div class="section-icon" style="background: linear-gradient(135deg, #ffd84f 0%, #ca9e00 100%); color: #000; font-weight: bold; font-size: 10px;">⚡</div>

                        <div>
                            <strong>Atributos (Stats)</strong>

                            <span>
                                Valores atuais e valores-base (editáveis)
                            </span>
                        </div>
                    </div>

                    <div class="analysis-stats-grid" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
                        ${criarCardStatAnalise("hp", bases.hp, pokemon.hp, "#4caf50")}
                        ${criarCardStatAnalise("atk", bases.atk, pokemon.atk, "#ff9800")}
                        ${criarCardStatAnalise("def", bases.def, pokemon.def, "#ffeb3b")}
                        ${criarCardStatAnalise("spa", bases.spa, pokemon.spa, "#2196f3")}
                        ${criarCardStatAnalise("spd", bases.spd, pokemon.spd, "#00bcd4")}
                        ${criarCardStatAnalise("vel", bases.vel, pokemon.vel, "#e91e63")}
                    </div>
                </div>
            </div>

            <div id="iv-results"></div>
        `;

        document
            .getElementById("toggle-form")
            .addEventListener("click", () => {
                formularioRecolhido =
                    !formularioRecolhido;

                const formulario =
                    document.getElementById(
                        "analysis-form"
                    );

                const botao =
                    document.getElementById(
                        "toggle-form"
                    );

                formulario?.classList.toggle(
                    "form-collapsed",
                    formularioRecolhido
                );

                if (botao) {
                    botao.textContent =
                        formularioRecolhido
                            ? "Mostrar"
                            : "Recolher";
                }

                const painel =
                    document.getElementById(
                        CONFIG.panelId
                    );

                if (painel) {
                    limitarPainelNaTela(painel);
                    salvarEstadoPainel(painel);
                }
            });

        area
            .querySelectorAll("input")
            .forEach(input => {
                input.addEventListener(
                    "input",
                    calcularPelosInputs
                );
            });

        // Atualiza o box de nível no hero card em tempo real
        const levelInp = document.getElementById("level-input");
        const heroNivelEl = document.getElementById("hero-nivel-val");
        if (levelInp && heroNivelEl) {
            levelInp.addEventListener("input", () => {
                heroNivelEl.textContent = levelInp.value || "-";
            });
        }

        function criarCardStatAnalise(chave, baseVal, currentVal, cor) {
            const idBase = `base-${chave}`;
            const idCurrent = `current-${chave}`;
            const labelText = NOMES_STATS_CURTOS[chave] || chave.toUpperCase();

            return `
            <div class="analysis-stat-card" style="
                display: flex;
                flex-direction: column;
                align-items: center;
                background: linear-gradient(135deg, #151d2a 0%, #0d141e 100%);
                border: 1px solid rgba(255,255,255,0.06);
                border-top: 3px solid ${cor};
                border-radius: 8px;
                padding: 6px;
                box-sizing: border-box;
                gap: 4px;
            ">
                <span style="color: ${cor}; font-size: 9px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">${labelText}</span>
                
                <input
                    id="${idCurrent}"
                    type="number"
                    min="0"
                    max="9999"
                    step="1"
                    value="${currentVal ?? ""}"
                    style="
                        width: 100%;
                        background: transparent;
                        border: none;
                        color: #fff;
                        font-size: 14px;
                        font-weight: bold;
                        text-align: center;
                        padding: 0;
                        margin: 0;
                        outline: none;
                        -moz-appearance: textfield;
                    "
                    class="flat-stat-input"
                >
                
                <div style="width: 100%; border-top: 1px dashed rgba(255,255,255,0.12); margin: 2px 0;"></div>
                
                <div style="display: flex; align-items: center; justify-content: center; gap: 3px; font-size: 10px; color: #8795aa; width: 100%;">
                    <span>base</span>
                    <input
                        id="${idBase}"
                        type="number"
                        min="0"
                        max="999"
                        step="1"
                        value="${baseVal ?? ""}"
                        style="
                            width: 30px;
                            background: transparent;
                            border: none;
                            color: #edf4ff;
                            font-size: 10px;
                            font-weight: bold;
                            text-align: left;
                            padding: 0;
                            margin: 0;
                            outline: none;
                            -moz-appearance: textfield;
                        "
                        class="flat-stat-input"
                    >
                </div>
            </div>
        `;
        }

        calcularPelosInputs();
    }

    function inputBase(chave, valor) {
        return criarInputStat(
            chave,
            valor,
            `base-${chave}`
        );
    }

    function inputAtual(chave, valor) {
        return criarInputStat(
            chave,
            valor,
            `current-${chave}`
        );
    }

    function criarInputStat(chave, valor, id) {
        return `
            <label
                class="stat-input-card"
                data-stat="${chave}"
            >
                <div class="stat-input-label">
                    <i>
                        ${ICONES_STATS[chave]}
                    </i>

                    <span>
                        ${NOMES_STATS_CURTOS[chave]}
                    </span>
                </div>

                <input
                    id="${id}"
                    type="number"
                    min="0"
                    max="999999"
                    step="1"
                    value="${valor ?? ""}"
                >
            </label>
        `;
    }

    function lerValorInput(id) {
        const campo =
            document.getElementById(id);

        if (!campo) return null;

        const valor =
            Number(
                String(campo.value)
                    .replace(",", ".")
            );

        return Number.isFinite(valor)
            ? valor
            : null;
    }

    function estimarIVIndividual({
        atributoAtual,
        atributoBase,
        nivel,
        qualidade,
        expoente
    }) {
        if (
            !Number.isFinite(atributoAtual) ||
            !Number.isFinite(atributoBase) ||
            !Number.isFinite(nivel) ||
            !Number.isFinite(qualidade) ||
            nivel <= 0 ||
            qualidade <= 0
        ) {
            return 0;
        }

        const fator = (nivel / 100) * Math.pow(qualidade, expoente);

        if (!Number.isFinite(fator) || fator <= 0) {
            return 0;
        }

        const ivFloat = (((atributoAtual / fator) - atributoBase) / 2);
        return limitar(ivFloat, 0, CONFIG.maxIVIndividual);
    }

    function calcularStat({
        base,
        iv,
        nivel,
        qualidade,
        expoente
    }) {
        return Math.round(
            (base + 2 * iv) *
            (nivel / 100) *
            Math.pow(qualidade, expoente)
        );
    }

    function calcularPoderEstimado({
        bases,
        ivs,
        nivel,
        qualidade
    }) {
        let soma = 0;

        for (
            const chave of Object.keys(
                CONFIG.expoentes
            )
        ) {
            soma += calcularStat({
                base: bases[chave],
                iv: ivs[chave],
                nivel,
                qualidade,
                expoente:
                    CONFIG.expoentes[chave]
            });
        }

        return soma * qualidade;
    }

    function calcularPotencialExemplar(
        baseStats,
        individualIvs,
        qualidade,
        maxIvIndividual = 32
    ) {
        // O IV (growth) mede o quão bem o Pokémon nasceu (0 a 192 total).
        // Seguindo a regra oficial: A Qualidade NÃO deve ser multiplicada pelo IV ("Mito do Tier * IV").
        // O IV reflete puramente a perfeição dos status de crescimento (Growth %) do espécime.
        const somaIvs = (individualIvs || []).reduce((total, iv) => total + (Number(iv) || 0), 0);
        const maxIvsTotal = maxIvIndividual * 6; // 192

        return Math.min(100, Math.max(0, (somaIvs / maxIvsTotal) * 100));
    }

    function calcularPelosInputs() {
        if (!ultimoPokemon && !pokemonManualAtual) return;

        const nivel =
            lerValorInput("level-input");

        const qualidade =
            lerValorInput("quality-input");

        const bases = {};
        const atuais = {};

        for (
            const chave of Object.keys(
                CONFIG.expoentes
            )
        ) {
            bases[chave] =
                lerValorInput(
                    `base-${chave}`
                );

            atuais[chave] =
                lerValorInput(
                    `current-${chave}`
                );
        }

        const ivTotalInputVal = lerValorInput("iv-total-input");
        const ivTotalFornecido = Number.isFinite(ivTotalInputVal) && ivTotalInputVal > 0;

        const camposInvalidos =
            !Number.isFinite(nivel) ||
            !Number.isFinite(qualidade) ||
            Object.values(bases).some(valor => !Number.isFinite(valor)) ||
            Object.values(atuais).some(valor => !Number.isFinite(valor));

        const area = document.getElementById("iv-results");
        if (!area) return;

        const miniContainer = document.getElementById("analysis-results-mini");
        const btnPiwAnalise = document.getElementById("btn-piw-tools-analise");

        if (btnPiwAnalise) {
            const pokeObj = pokemonManualAtual || ultimoPokemon;
            if (pokeObj) {
                const tempPoke = {
                    ...pokeObj,
                    nivel: Number.isFinite(nivel) ? nivel : pokeObj.nivel,
                    hp: Number.isFinite(atuais.hp) ? atuais.hp : pokeObj.hp,
                    atk: Number.isFinite(atuais.atk) ? atuais.atk : pokeObj.atk,
                    def: Number.isFinite(atuais.def) ? atuais.def : pokeObj.def,
                    spa: Number.isFinite(atuais.spa) ? atuais.spa : pokeObj.spa,
                    spd: Number.isFinite(atuais.spd) ? atuais.spd : pokeObj.spd,
                    vel: Number.isFinite(atuais.vel) ? atuais.vel : pokeObj.vel
                };
                btnPiwAnalise.href = gerarUrlPIWTools(tempPoke);
            }
        }

        if (camposInvalidos) {
            if (miniContainer) miniContainer.style.display = "none";
            area.innerHTML = `
                <div class="warning">
                    <strong>Preencha todos os campos</strong>

                    <span>
                        Todos os valores de atributos atuais e base são necessários para calcular os IVs.
                    </span>
                </div>
            `;

            return;
        }

        const ivsFloats = {};
        for (const chave of Object.keys(CONFIG.expoentes)) {
            ivsFloats[chave] = estimarIVIndividual({
                atributoAtual: atuais[chave],
                atributoBase: bases[chave],
                nivel,
                qualidade,
                expoente: CONFIG.expoentes[chave]
            });
        }

        const ivs = {
            hp: arredondar(ivsFloats.hp ?? 0, 1),
            atk: arredondar(ivsFloats.atk ?? 0, 1),
            def: arredondar(ivsFloats.def ?? 0, 1),
            spa: arredondar(ivsFloats.spa ?? 0, 1),
            spd: arredondar(ivsFloats.spd ?? 0, 1),
            vel: arredondar(ivsFloats.vel ?? 0, 1)
        };

        // Soma direta dos floats brutos (sem perda de precisão)
        const somaFloatExact = Object.values(ivsFloats).reduce((s, v) => s + (v || 0), 0);

        // Se o IV Total for fornecido (pelo jogo ou editado pelo usuário em iv-total-input), ele tem prioridade absoluta!
        const ivTotalFinal = ivTotalFornecido ? ivTotalInputVal : Math.ceil(somaFloatExact);
        const percentualIV = (ivTotalFinal / CONFIG.maxIVTotal) * 100;

        const ivsMaximos = {
            hp: CONFIG.maxIVIndividual,
            atk: CONFIG.maxIVIndividual,
            def: CONFIG.maxIVIndividual,
            spa: CONFIG.maxIVIndividual,
            spd: CONFIG.maxIVIndividual,
            vel: CONFIG.maxIVIndividual
        };

        const poderEstimado = calcularPoderEstimado({
            bases,
            ivs,
            nivel,
            qualidade
        });

        const baseStatsArr = [bases.hp, bases.atk, bases.def, bases.spa, bases.spd, bases.vel];
        const individualIvsArr = [ivs.hp, ivs.atk, ivs.def, ivs.spa, ivs.spd, ivs.vel];
        const potencial = ivTotalFornecido
            ? Math.min(100, Math.max(0, (ivTotalInputVal / CONFIG.maxIVTotal) * 100))
            : calcularPotencialExemplar(baseStatsArr, individualIvsArr, qualidade, CONFIG.maxIVIndividual);

        const classificacao = classificarPotencial(potencial);
        const grausCirculo = limitar(potencial, 0, 100) * 3.6;

        const miniQuality = document.getElementById("mini-val-quality");
        const miniIv = document.getElementById("mini-val-iv");
        const miniPower = document.getElementById("mini-val-power");

        if (miniQuality && miniIv && miniPower && miniContainer) {
            miniQuality.textContent = formatarDecimal(qualidade, 2);
            miniIv.textContent = formatarDecimal(ivTotalFinal, 1);
            miniPower.textContent = formatarNumero(Math.round(poderEstimado));
            miniContainer.style.display = "flex";
        }

        area.innerHTML = `
            <div class="result-wrapper">
                ${nivel < 15 ? `
                    <div class="warning level-warning" style="margin-bottom: 10px; padding: 8px 10px; background: rgba(243, 154, 75, 0.15); border: 1px solid rgba(243, 154, 75, 0.4); border-radius: 8px; color: #ffd77d; font-size: 10px; display: flex; align-items: center; gap: 6px;">
                        <span style="font-size: 14px;">⚠️</span>
                        <div>
                            <strong style="color: #ffd77d; font-size: 10px;">Atenção: Nível Nv. ${nivel} (&lt; 15)</strong>
                            <span style="display: block; font-size: 9px; color: #e2b069; margin-top: 1px;">Para o cálculo de IV ser preciso, o Pokémon precisa estar no Nv. 15 ou superior.</span>
                        </div>
                    </div>
                ` : ""}

                <div class="result-title">
                    <div>
                        <span class="result-eyebrow">
                            RESULTADO DA ANÁLISE
                        </span>

                        <strong>
                            Potencial do exemplar
                        </strong>
                    </div>

                    <span class="result-check">
                        ✓
                    </span>
                </div>

                <div class="result-main-card">
                    <div
                        class="score-circle"
                        style="
                            --score:${grausCirculo}deg;
                            --score-color:${classificacao.cor};
                        "
                    >
                        <div>
                            <strong>
                                ${Math.round(potencial)}%
                            </strong>

                            <span>
                                potencial
                            </span>
                        </div>
                    </div>

                    <div class="result-description">
                        <small>
                            CLASSIFICAÇÃO
                        </small>

                        <strong
                            style="
                                color:${classificacao.cor}
                            "
                        >
                            ${escapeHtml(
            classificacao.texto
        )}
                        </strong>

                        <p>
                            ${escapeHtml(
            classificacao.descricao
        )}
                        </p>
                    </div>
                </div>

                <div class="overall-progress">
                    <div>
                        <span>
                            Eficiência total de IV
                        </span>

                        <strong>
                            ${formatarDecimal(
            percentualIV,
            1
        )}%
                        </strong>
                    </div>

                    <div class="overall-track">
                        <div
                            style="
                                width:${limitar(
            percentualIV,
            0,
            100
        )}%;
                                background:${classificacao.cor};
                            "
                        ></div>
                    </div>
                </div>
            </div>

            <div class="individual-section">
                <div class="individual-heading">
                    <div>
                        <strong>IVs individuais</strong>

                        <span>
                            Desempenho por atributo
                        </span>
                    </div>

                    <span class="individual-total">
                        ${formatarDecimal(ivTotalFinal, 1)}/192
                    </span>
                </div>

                <div class="iv-grid">
                    ${resultadoIV("hp", ivs.hp)}
                    ${resultadoIV("atk", ivs.atk)}
                    ${resultadoIV("def", ivs.def)}
                    ${resultadoIV("spa", ivs.spa)}
                    ${resultadoIV("spd", ivs.spd)}
                    ${resultadoIV("vel", ivs.vel)}
                </div>
            </div>

            <div class="analysis-note">
                <span>ⓘ</span>

                <p>
                    <strong>Fórmula Oficial:</strong> Power = (Soma dos Stats) × Qualidade.<br>
                    A Qualidade pesa mais que o IV porque reforça cada stat e multiplica o Power final. O IV (growth) representa o nascimento do Pokémon (0 a 192 total).
                </p>
            </div>
        `;

        const painel =
            document.getElementById(CONFIG.panelId);

        if (painel) {
            limitarPainelNaTela(painel);
        }
    }

    function classificarPotencial(percentual) {
        if (percentual >= 95) {
            return {
                texto: "Excepcional",
                cor: "#61f6a4",
                descricao:
                    "Um exemplar extremamente próximo do potencial máximo."
            };
        }

        if (percentual >= 85) {
            return {
                texto: "Excelente",
                cor: "#54e7d2",
                descricao:
                    "Ótimos atributos e excelente eficiência geral."
            };
        }

        if (percentual >= 72) {
            return {
                texto: "Muito bom",
                cor: "#5ed7b9",
                descricao:
                    "Um Pokémon forte e acima da média."
            };
        }

        if (percentual >= 58) {
            return {
                texto: "Bom",
                cor: "#69b7ff",
                descricao:
                    "Bom equilíbrio de atributos para uso geral."
            };
        }

        if (percentual >= 42) {
            return {
                texto: "Mediano",
                cor: "#f1c644",
                descricao:
                    "Possui atributos equilibrados, mas pode melhorar."
            };
        }

        if (percentual >= 25) {
            return {
                texto: "Abaixo da média",
                cor: "#f39a4b",
                descricao:
                    "Alguns atributos importantes estão abaixo do ideal."
            };
        }

        return {
            texto: "Fraco",
            cor: "#f05a62",
            descricao:
                "Baixo potencial geral em comparação ao máximo possível."
        };
    }

    function classificarIV(valor) {
        if (valor >= 31.5) {
            return {
                texto: "Perfeito",
                classe: "perfect"
            };
        }

        if (valor >= 27) {
            return {
                texto: "Ótimo",
                classe: "great"
            };
        }

        if (valor >= 21) {
            return {
                texto: "Bom",
                classe: "good"
            };
        }

        if (valor >= 14) {
            return {
                texto: "Médio",
                classe: "average"
            };
        }

        return {
            texto: "Baixo",
            classe: "low"
        };
    }

    function resultadoIV(chave, valor) {
        const percentual =
            limitar(
                (
                    valor /
                    CONFIG.maxIVIndividual
                ) * 100,
                0,
                100
            );

        const classificacao =
            classificarIV(valor);

        return `
            <div
                class="iv-item"
                data-stat="${chave}"
            >
                <div class="iv-item-top">
                    <div class="iv-stat-name">
                        <span>
                            ${ICONES_STATS[chave]}
                        </span>

                        <div>
                            <strong>
                                ${escapeHtml(
            NOMES_STATS_CURTOS[chave]
        )}
                            </strong>

                            <small>
                                ${escapeHtml(
            NOMES_STATS[chave]
        )}
                            </small>
                        </div>
                    </div>

                    <div class="iv-value">
                        <strong>
                            ${formatarDecimal(
            valor,
            1
        )}
                        </strong>

                        <span>/32</span>
                    </div>
                </div>

                <div class="iv-track">
                    <div
                        style="width:${percentual}%"
                    ></div>
                </div>

                <div class="iv-item-bottom">
                    <span
                        class="
                            iv-rating
                            ${classificacao.classe}
                        "
                    >
                        ${classificacao.texto}
                    </span>

                    <span>
                        ${formatarDecimal(
            percentual,
            0
        )}%
                    </span>
                </div>
            </div>
        `;
    }

    async function escreverClipboard(texto) {
        try {
            await navigator.clipboard.writeText(texto);
            return true;
        } catch (erro) {
            const textarea =
                document.createElement("textarea");

            textarea.value = texto;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";

            document.body.appendChild(textarea);

            textarea.focus();
            textarea.select();

            const resultado =
                document.execCommand("copy");

            textarea.remove();

            return resultado;
        }
    }

    async function copiarTexto() {
        if (!ultimoPokemon) return;

        const p = ultimoPokemon;

        const texto = [
            `Nome: ${p.nome}`,
            `Tipos: ${p.tipos.join(", ")}`,
            `Ativo: ${p.ativo ? "Sim" : "Não"}`,
            `Nível: ${p.nivel ?? "-"}`,
            `Qualidade: ${p.qualidade ?? "-"}`,
            `IV: ${p.ivAtual !== null
                ? `${p.ivAtual}/${p.ivMaximo}`
                : "-"
            }`,
            `HP: ${p.hp ?? "-"}`,
            `Atk: ${p.atk ?? "-"}`,
            `Def: ${p.def ?? "-"}`,
            `SpA: ${p.spa ?? "-"}`,
            `SpD: ${p.spd ?? "-"}`,
            `Vel: ${p.vel ?? "-"}`,
            `Poder: ${p.poder ?? "-"}`
        ].join("\n");

        await escreverClipboard(texto);
    }

    async function copiarJson() {
        if (!ultimoPokemon) return;

        await escreverClipboard(
            JSON.stringify(
                ultimoPokemon,
                null,
                2
            )
        );
    }

    function normalizarNomePokemon(nome) {
        if (!nome) return "";
        return String(nome)
            .toLowerCase()
            .replace(/^shiny\s+/i, "")
            .replace(/\s+shiny$/i, "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]/g, "")
            .trim();
    }

    function parsePokemon(texto) {
        if (!texto || typeof texto !== "string") return null;

        const linhas = texto.split("\n").map(l => l.trim()).filter(Boolean);
        if (linhas.length === 0) return null;

        let nome = "";
        let nivel = null;

        const primeiraLinha = linhas[0];
        const matchNv = primeiraLinha.match(/^(.+?)\s+(?:Nv\.?|Lv\.?|Nível|Level)\s*(\d+)/i) ||
                        texto.match(/(.+?)\s+(?:Nv\.?|Lv\.?|Nível|Level)\s*(\d+)/i);
        if (matchNv) {
            nome = matchNv[1].replace(/[()]/g, "").trim();
            nivel = parseInt(matchNv[2], 10);
        } else {
            nome = primeiraLinha.replace(/[()]/g, "").trim();
        }

        if (!nome) return null;

        if (nivel === null) {
            const matchLvl = texto.match(/(?:Nv\.?|Lv\.?|Nível|Level)\s*:?\s*(\d+)/i);
            if (matchLvl) nivel = parseInt(matchLvl[1], 10);
        }

        let poder = null;
        const matchPoder = texto.match(/(?:Poder|Power)\s*:?\s*([\d.]+)/i);
        if (matchPoder) {
            poder = parseInt(matchPoder[1].replace(/\./g, ""), 10);
        }

        let qualidade = null;
        let multQualidade = 1.0;
        const matchQual = texto.match(/(?:Qualidade|Quality)\s*:?\s*([\d.,]+)/i);
        if (matchQual) {
            const qNum = parseFloat(matchQual[1].replace(",", "."));
            if (!isNaN(qNum)) {
                qualidade = qNum;
                multQualidade = qNum;
            }
        }

        let ivAtual = null;
        let ivMaximo = 192;
        const matchIV = texto.match(/IV\s*:?\s*([\d.,]+)(?:\s*\/\s*(\d+))?/i);
        if (matchIV) {
            ivAtual = parseFloat(matchIV[1].replace(",", "."));
            if (matchIV[2]) ivMaximo = parseInt(matchIV[2], 10);
        }

        const extrairStat = (pattern) => {
            const m = texto.match(pattern);
            if (m) {
                const v = parseInt(m[1].replace(/\./g, ""), 10);
                return isNaN(v) ? null : v;
            }
            return null;
        };

        const hp = extrairStat(/(?:HP|Vida)\s*:?\s*(\d+)/i);
        const atk = extrairStat(/(?:Atk|Ataque|Attack)\s*:?\s*(\d+)/i);
        const def = extrairStat(/(?:Def|Defesa|Defense)\s*:?\s*(\d+)/i);
        const spa = extrairStat(/(?:SpA|Sp\.?\s*Atk|Ataque\s*Especial)\s*:?\s*(\d+)/i);
        const spd = extrairStat(/(?:SpD|Sp\.?\s*Def|Defesa\s*Especial)\s*:?\s*(\d+)/i);
        const vel = extrairStat(/(?:Vel|Speed|Velocidade)\s*:?\s*(\d+)/i);

        let tipos = [];
        const matchTipos = texto.match(/(?:Tipos?|Types?)\s*:?\s*([^\n]+)/i);
        if (matchTipos) {
            tipos = matchTipos[1].split(/[,/]/).map(t => t.trim()).filter(Boolean);
        }

        const ativo = texto.toLowerCase().includes("ativo") || texto.includes("⚔");

        return {
            nome,
            nivel: nivel ?? 1,
            poder: poder ?? 0,
            qualidade: qualidade ?? 1.0,
            multiplicadorQualidade: multQualidade,
            ivAtual,
            ivMaximo,
            hp,
            atk,
            def,
            spa,
            spd,
            vel,
            tipos: tipos.length > 0 ? tipos : ["Normal"],
            ativo
        };
    }

    function processarTooltip(tooltip) {
        if (!mouseTrackingEnabled) return;

        const texto = tooltip?.innerText?.trim() || tooltip?.textContent?.trim();

        if (!texto || texto === ultimoTexto) {
            return;
        }

        const temPoderOuNivel = (texto.includes("Poder") || texto.includes("Power") || texto.includes("Poder:")) ||
                                (/(?:Nv\.?|Lv\.?|Nível|Level)\s*\d+/i.test(texto));
        const temStats = texto.includes("HP") || texto.includes("Atk") || texto.includes("Ataque") || texto.includes("Defesa") || texto.includes("Qualidade");

        if (!temPoderOuNivel && !temStats) {
            return;
        }

        const pokemon = parsePokemon(texto);

        if (!pokemon) return;

        if (ultimoPokemon && normalizarNomePokemon(ultimoPokemon.nome) !== normalizarNomePokemon(pokemon.nome)) {
            danoPorGolpe.clear();
            ultimoGolpeUsado = null;
        }

        ultimoTexto = texto;
        ultimoPokemon = pokemon;

        const painel = document.getElementById(CONFIG.panelId);
        if (painel) {
            painel.style.display = "flex";
        }

        atualizarPainelLeitor(pokemon);
        carregarAnalise(pokemon);
        atualizarPainelMoves();
        atualizarPosicaoPainelMoves();
        atualizarPosicaoPainelItens();
        atualizarPainelComparacao();

        console.log("[Poké Leitor] Pokémon capturado:", pokemon);
    }

    function observarTooltips() {
        const TOOLTIP_SELECTORS = ".inv-tip, .poke-tip, .item-tip, .tooltip, [class*='tip'], [class*='tooltip']";

        const checarElemento = (node) => {
            if (!(node instanceof HTMLElement)) return;
            if (node.matches?.(TOOLTIP_SELECTORS)) {
                processarTooltip(node);
            }
            const interno = node.querySelector?.(TOOLTIP_SELECTORS);
            if (interno) {
                processarTooltip(interno);
            }
        };

        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    checarElemento(node);
                }
            }
            const tooltipAtual = document.querySelector(TOOLTIP_SELECTORS);
            if (tooltipAtual) {
                processarTooltip(tooltipAtual);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        // Escutador direto de movimento do mouse no documento para resposta instantânea ao passar o mouse
        const escutarMouse = (e) => {
            if (!mouseTrackingEnabled) return;
            const alvo = e.target;
            if (!alvo) return;
            const tipEl = alvo.closest?.(TOOLTIP_SELECTORS) || document.querySelector(TOOLTIP_SELECTORS);
            if (tipEl) {
                processarTooltip(tipEl);
            }
        };

        document.addEventListener("mouseover", escutarMouse, { passive: true });
        document.addEventListener("mousemove", escutarMouse, { passive: true });

        console.log("[Poké Leitor] Poké Leitor e Analisador de Tooltips iniciado com sucesso.");
    }

    function criarCSS() {
        return `
            #${CONFIG.panelId} {
                position: fixed;
                top: 80px;
                right: 20px;
                width: 340px;
                max-height: calc(100vh - 20px);
                z-index: 2147483647;
                overflow: hidden;
                color: #f7f7f7;
                background:
                    radial-gradient(
                        circle at top right,
                        rgba(67, 141, 243, 0.08),
                        transparent 42%
                    ),
                    linear-gradient(
                        165deg,
                        #151923 0%,
                        #0c0f16 55%,
                        #080a0f 100%
                    );
                border: 2px solid #f1c644;
                border-radius: 16px;
                box-shadow:
                    0 0 0 3px rgba(0,0,0,.75),
                    0 14px 40px rgba(0,0,0,.7),
                    0 0 24px rgba(241,198,68,.12);
                font-family:
                    Arial,
                    Helvetica,
                    sans-serif;
                font-size: 13px;
                display: flex;
                flex-direction: column;
            }

            #${CONFIG.panelId} * {
                box-sizing: border-box;
            }

            #${CONFIG.panelId}.minimized {
                width: 235px !important;
                height: 48px !important;
            }

            #${CONFIG.panelId}.minimized #panel-body,
            #${CONFIG.panelId}.minimized .led-area,
            #${CONFIG.panelId}.minimized .top-banners-grid,
            #${CONFIG.panelId}.minimized #toggle-moves,
            #${CONFIG.panelId}.minimized #toggle-items,
            #${CONFIG.panelId}.minimized #toggle-shiny,
            #${CONFIG.panelId}.minimized #toggle-daily {
                display: none !important;
            }

            #${CONFIG.panelId}.dragging {
                opacity: .93;
                transform: scale(.99);
            }

            #${CONFIG.panelId} #resize-handle {
                position: absolute;
                right: 0;
                bottom: 0;
                width: 14px;
                height: 14px;
                cursor: se-resize;
                z-index: 10000;
                background: linear-gradient(135deg, transparent 45%, rgba(241,198,68,0.4) 45%, rgba(241,198,68,0.4) 55%, transparent 55%, transparent 65%, rgba(241,198,68,0.4) 65%);
                border-radius: 0 0 14px 0;
            }

            #${CONFIG.panelId}.minimized #resize-handle {
                display: none;
            }

            #${CONFIG.panelId} .header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 10px;
                min-height: 48px;
                padding: 9px 10px;
                cursor: grab;
                user-select: none;
                background:
                    linear-gradient(
                        180deg,
                        #e8403d,
                        #b91f27 55%,
                        #8e141c
                    );
                border-bottom: 3px solid #151515;
            }

            #${CONFIG.panelId}
            .title-area {
                display: flex;
                align-items: center;
                gap: 9px;
            }

            #${CONFIG.panelId}
            .title-area > div:last-child {
                display: flex;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .title-area strong {
                color: #fff;
                font-size: 14px;
            }

            #${CONFIG.panelId}
            .title-area small {
                margin-top: 3px;
                color: rgba(255,255,255,.72);
                font-size: 9px;
                letter-spacing: .7px;
                text-transform: uppercase;
            }

            #${CONFIG.panelId}
            .pokeball,
            #${CONFIG.panelId}
            .empty-ball,
            #${CONFIG.panelId}
            .loading-ball {
                position: relative;
                overflow: hidden;
                border: 2px solid #171717;
                border-radius: 50%;
                background:
                    linear-gradient(
                        to bottom,
                        #f34848 0%,
                        #f34848 43%,
                        #151515 43%,
                        #151515 57%,
                        #f7f7f7 57%
                    );
            }

            #${CONFIG.panelId}
            .pokeball {
                width: 29px;
                height: 29px;
            }

            #${CONFIG.panelId} .sprite {
                width: 100%;
                height: 100%;
                image-rendering: pixelated;
                object-fit: contain;
            }

            #${CONFIG.panelId} .type-badge {
                display: inline-block;
                padding: 2px 7px;
                border-radius: 99px;
                font-size: 8px;
                font-weight: bold;
                color: #fff;
                text-shadow: 0 1px 1px rgba(0,0,0,0.5);
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15);
            }

            #${CONFIG.panelId}
            .empty-ball {
                width: 48px;
                height: 48px;
                margin-bottom: 8px;
                animation:
                    float 2.2s
                    ease-in-out infinite;
            }

            #${CONFIG.panelId}
            .loading-ball {
                width: 42px;
                height: 42px;
                margin-bottom: 12px;
                animation:
                    spin 1.1s
                    linear infinite;
            }

            #${CONFIG.panelId}
            .pokeball span,
            #${CONFIG.panelId}
            .empty-ball span,
            #${CONFIG.panelId}
            .loading-ball span {
                position: absolute;
                top: 50%;
                left: 50%;
                border: 2px solid #171717;
                border-radius: 50%;
                background: #fff;
                transform:
                    translate(-50%, -50%);
            }

            #${CONFIG.panelId}
            .pokeball span {
                width: 8px;
                height: 8px;
            }

            #${CONFIG.panelId}
            .empty-ball span,
            #${CONFIG.panelId}
            .loading-ball span {
                width: 12px;
                height: 12px;
            }

            #${CONFIG.panelId}
            .header-actions {
                display: flex;
                gap: 3px;
            }

            #${CONFIG.panelId}
            .header-actions button {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 26px;
                height: 26px;
                padding: 0;
                color: #fff;
                background: rgba(0,0,0,.18);
                border:
                    1px solid rgba(255,255,255,.18);
                border-radius: 7px;
                cursor: pointer;
                font-size: 18px;
                font-weight: bold;
            }

            #${CONFIG.panelId}
            .led-area {
                display: flex;
                align-items: center;
                gap: 7px;
                height: 28px;
                padding: 0 12px;
                background:
                    linear-gradient(
                        #252a34,
                        #171b23
                    );
            }

            #${CONFIG.panelId}
            .main-led {
                width: 15px;
                height: 15px;
                margin-right: 3px;
                border: 2px solid #dceaff;
                border-radius: 50%;
                background: #4fc6ff;
                box-shadow:
                    inset 0 0 4px #fff,
                    0 0 7px #4fc6ff;
            }

            #${CONFIG.panelId}
            .small-led {
                width: 7px;
                height: 7px;
                border-radius: 50%;
            }

            #${CONFIG.panelId}
            .led-red {
                background: #ff4b4b;
            }

            #${CONFIG.panelId}
            .led-yellow {
                background: #ffd64c;
            }

            #${CONFIG.panelId}
            .led-green {
                background: #54d66b;
            }

            #${CONFIG.panelId}
            #panel-body {
                flex: 1;
                min-height: 0;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color:
                    #ca3035 #111722;
            }

            #${CONFIG.panelId}
            .tabs {
                display: grid;
                grid-template-columns: 1fr 1fr;
                padding: 7px;
                gap: 5px;
                background: #0d1420;
                border-bottom:
                    1px solid rgba(255,255,255,.08);
            }

            #${CONFIG.panelId}
            .tab-button {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                padding: 9px 4px;
                color: #7d899d;
                background: transparent;
                border: 1px solid transparent;
                border-radius: 8px;
                cursor: pointer;
                font-size: 10px;
                font-weight: bold;
                text-transform: uppercase;
                transition:
                    color .15s ease,
                    background .15s ease,
                    transform .15s ease;
            }

            #${CONFIG.panelId}
            .tab-button:hover {
                color: #dfe8f5;
                background: #151e2d;
            }

            #${CONFIG.panelId}
            .tab-button.active {
                color: #fff;
                background:
                    linear-gradient(
                        180deg,
                        #d83a3f,
                        #9f2228
                    );
                border-color: #f06468;
                box-shadow:
                    0 4px 10px rgba(159,34,40,.25);
            }

            #${CONFIG.panelId}
            .tab-icon {
                font-size: 12px;
            }

            #${CONFIG.panelId}
            .tab-content {
                display: none;
            }

            #${CONFIG.panelId}
            .tab-content.active {
                display: block;
            }

            #${CONFIG.panelId}
            #content {
                padding: 13px;
            }

            #${CONFIG.panelId}
            .empty,
            #${CONFIG.panelId}
            .analysis-empty,
            #${CONFIG.panelId}
            .loading {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 170px;
                padding: 18px;
                color: #8c98aa;
                text-align: center;
            }

            #${CONFIG.panelId}
            .empty strong,
            #${CONFIG.panelId}
            .analysis-empty strong,
            #${CONFIG.panelId}
            .loading strong {
                color: #f1c644;
                font-size: 14px;
            }

            #${CONFIG.panelId}
            .empty small,
            #${CONFIG.panelId}
            .analysis-empty > span,
            #${CONFIG.panelId}
            .loading span {
                margin-top: 5px;
                max-width: 230px;
                color: #758196;
                font-size: 11px;
                line-height: 1.45;
            }

            #${CONFIG.panelId}
            .analysis-empty-icon {
                display: grid;
                place-items: center;
                width: 58px;
                height: 58px;
                margin-bottom: 12px;
                background:
                    linear-gradient(
                        145deg,
                        #17304b,
                        #0b1728
                    );
                border: 1px solid #315a7c;
                border-radius: 18px;
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,.07),
                    0 10px 25px rgba(0,0,0,.25);
            }

            #${CONFIG.panelId}
            .analysis-empty-icon span {
                color: #5de6d5;
                font-size: 18px;
                font-weight: 900;
            }

            #${CONFIG.panelId}
            .empty-tips {
                display: grid;
                gap: 5px;
                width: 100%;
                margin-top: 16px;
            }

            #${CONFIG.panelId}
            .empty-tips div {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 7px 9px;
                color: #8693a8;
                background: #101827;
                border: 1px solid #1c2a3e;
                border-radius: 7px;
                font-size: 9px;
                text-align: left;
            }

            #${CONFIG.panelId}
            .empty-tips b {
                display: grid;
                place-items: center;
                width: 18px;
                height: 18px;
                color: #09101b;
                background: #55e6d3;
                border-radius: 50%;
                font-size: 9px;
            }

            #${CONFIG.panelId}
            .pokemon-card {
                overflow: hidden;
                background:
                    linear-gradient(
                        145deg,
                        rgba(255,255,255,.06),
                        rgba(255,255,255,.015)
                    );
                border:
                    1px solid rgba(255,255,255,.09);
                border-radius: 11px;
            }

            #${CONFIG.panelId}
            .pokemon-top {
                padding: 12px;
                background:
                    radial-gradient(
                        circle at top right,
                        rgba(241,198,68,.2),
                        transparent 50%
                    ),
                    rgba(0,0,0,.18);
            }

            #${CONFIG.panelId}
            .name-line {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }

            #${CONFIG.panelId}
            .name {
                color: #ffd84f;
                font-size: 19px;
                font-weight: 800;
            }

            #${CONFIG.panelId}
            .level-badge {
                padding: 4px 8px;
                color: #fff;
                background: #ca3035;
                border: 1px solid #ff6b6f;
                border-radius: 999px;
                font-size: 10px;
                font-weight: bold;
            }

            #${CONFIG.panelId}
            .types {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                margin-top: 9px;
            }

            #${CONFIG.panelId}
            .type-chip {
                padding: 4px 8px;
                color: #fff;
                background:
                    linear-gradient(
                        #7650a9,
                        #513271
                    );
                border-radius: 999px;
                font-size: 9px;
                font-weight: bold;
            }

            #${CONFIG.panelId}
            .active-chip {
                background:
                    linear-gradient(
                        #e54b4f,
                        #9d252b
                    );
            }

            #${CONFIG.panelId}
            .info-area {
                padding: 8px 10px 10px;
            }

            #${CONFIG.panelId}
            .row {
                display: flex;
                justify-content: space-between;
                gap: 10px;
                padding: 5px 2px;
                border-bottom:
                    1px solid rgba(255,255,255,.055);
            }

            #${CONFIG.panelId}
            .row span,
            #${CONFIG.panelId}
            .stat-label {
                color: #aeb7c7;
                font-size: 10px;
            }

            #${CONFIG.panelId}
            .stat-row {
                display: grid;
                grid-template-columns:
                    85px 1fr 38px;
                align-items: center;
                gap: 7px;
                padding: 4px 2px;
            }

            #${CONFIG.panelId}
            .stat-value {
                text-align: right;
            }

            #${CONFIG.panelId}
            .stat-track {
                overflow: hidden;
                height: 6px;
                background: #263146;
                border-radius: 99px;
            }

            #${CONFIG.panelId}
            .stat-fill {
                height: 100%;
                background:
                    linear-gradient(
                        90deg,
                        #e44045,
                        #f2c744,
                        #61ce70
                    );
            }

            #${CONFIG.panelId}
            .power {
                display: flex;
                justify-content: space-between;
                margin-top: 8px;
                padding: 9px 10px;
                color: #ffe262;
                background:
                    linear-gradient(
                        90deg,
                        rgba(202,48,53,.22),
                        rgba(241,198,68,.13)
                    );
                border:
                    1px solid rgba(241,198,68,.3);
                border-radius: 8px;
            }

            #${CONFIG.panelId}
            .actions {
                display: flex;
                gap: 7px;
                padding: 10px 12px;
            }

            #${CONFIG.panelId}
            .actions button {
                flex: 1;
                padding: 9px;
                color: #fff;
                background:
                    linear-gradient(
                        #d83a3f,
                        #9f2228
                    );
                border: 1px solid #f06468;
                border-radius: 8px;
                cursor: pointer;
                font-size: 10px;
                font-weight: bold;
            }

            #${CONFIG.panelId}
            .actions button:last-child {
                color: #171717;
                background:
                    linear-gradient(
                        #f4d65e,
                        #cba52a
                    );
                border-color: #ffe984;
            }

            #${CONFIG.panelId}
            .analysis-hero {
                position: relative;
                display: flex;
                align-items: center;
                gap: 10px;
                overflow: hidden;
                min-height: 88px;
                padding: 14px;
                background:
                    radial-gradient(
                        circle at 85% 10%,
                        rgba(85,230,211,.15),
                        transparent 40%
                    ),
                    linear-gradient(
                        135deg,
                        #102039,
                        #091321
                    );
                border-bottom:
                    1px solid rgba(255,255,255,.08);
            }

            #${CONFIG.panelId}
            .analysis-hero-pattern {
                position: absolute;
                inset: 0;
                pointer-events: none;
                opacity: .18;
                background-image:
                    linear-gradient(
                        rgba(255,255,255,.08) 1px,
                        transparent 1px
                    ),
                    linear-gradient(
                        90deg,
                        rgba(255,255,255,.08) 1px,
                        transparent 1px
                    );
                background-size: 14px 14px;
                mask-image:
                    linear-gradient(
                        90deg,
                        transparent,
                        #000
                    );
            }

            #${CONFIG.panelId}
            .analysis-pokemon-icon {
                position: relative;
                z-index: 1;
                display: grid;
                place-items: center;
                flex: 0 0 auto;
                width: 52px;
                height: 52px;
                background:
                    linear-gradient(
                        145deg,
                        #1b3858,
                        #0c192c
                    );
                border: 1px solid #3a6688;
                border-radius: 16px;
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,.08),
                    0 8px 20px rgba(0,0,0,.3);
            }

            #${CONFIG.panelId}
            .analysis-pokemon-icon span {
                color: #5ce8d7;
                font-size: 16px;
                font-weight: 900;
                text-shadow:
                    0 0 12px rgba(92,232,215,.35);
            }

            #${CONFIG.panelId}
            .analysis-identity {
                position: relative;
                z-index: 1;
                display: flex;
                flex: 1;
                min-width: 0;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .analysis-identity > small {
                color: #58d9ca;
                font-size: 7px;
                font-weight: bold;
                letter-spacing: 1.4px;
            }

            #${CONFIG.panelId}
            .analysis-identity > strong {
                overflow: hidden;
                margin-top: 3px;
                color: #fff;
                font-size: 18px;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            #${CONFIG.panelId}
            .analysis-types {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                margin-top: 6px;
            }

            #${CONFIG.panelId}
            .analysis-types span {
                padding: 3px 6px;
                color: #cad6e7;
                background: rgba(255,255,255,.07);
                border:
                    1px solid rgba(255,255,255,.08);
                border-radius: 999px;
                font-size: 7px;
                font-weight: bold;
                text-transform: uppercase;
            }

            #${CONFIG.panelId}
            .analysis-level {
                position: relative;
                z-index: 1;
                display: flex;
                flex: 0 0 auto;
                flex-direction: column;
                align-items: center;
                min-width: 45px;
                padding: 7px 8px;
                background: rgba(0,0,0,.24);
                border:
                    1px solid rgba(255,255,255,.1);
                border-radius: 10px;
            }

            #${CONFIG.panelId}
            .analysis-level small {
                color: #7889a1;
                font-size: 6px;
                letter-spacing: 1px;
            }

            #${CONFIG.panelId}
            .analysis-level b {
                margin-top: 2px;
                color: #f1c644;
                font-size: 15px;
            }

            #${CONFIG.panelId}
            .analysis-toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 11px 13px;
                background: #0c1421;
                border-bottom:
                    1px solid rgba(255,255,255,.06);
            }

            #${CONFIG.panelId}
            .analysis-toolbar > div {
                display: flex;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .analysis-toolbar strong {
                color: #dce6f3;
                font-size: 11px;
            }

            #${CONFIG.panelId}
            .analysis-toolbar span {
                margin-top: 2px;
                color: #68768c;
                font-size: 8px;
            }

            #${CONFIG.panelId}
            #toggle-form {
                padding: 5px 8px;
                color: #8fded4;
                background: #112433;
                border: 1px solid #275268;
                border-radius: 6px;
                cursor: pointer;
                font-size: 8px;
                font-weight: bold;
                text-transform: uppercase;
            }

            #${CONFIG.panelId}
            .form-collapsed {
                display: none;
            }

            #${CONFIG.panelId}
            .primary-fields {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 6px;
                padding: 12px;
                background: #0b111c;
            }

            #${CONFIG.panelId}
            .primary-field {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            #${CONFIG.panelId}
            .primary-field > span {
                display: flex;
                align-items: center;
                gap: 5px;
                color: #8f9db2;
                font-size: 8px;
                font-weight: bold;
                text-transform: uppercase;
            }

            #${CONFIG.panelId}
            .primary-field > span i {
                color: #55e6d3;
                font-style: normal;
            }

            #${CONFIG.panelId}
            .input-with-suffix {
                position: relative;
            }

            #${CONFIG.panelId}
            .input-with-suffix input {
                padding-right: 30px;
            }

            #${CONFIG.panelId}
            .input-with-suffix b {
                position: absolute;
                top: 50%;
                right: 9px;
                color: #587089;
                font-size: 9px;
                transform: translateY(-50%);
                pointer-events: none;
            }

            #${CONFIG.panelId} input {
                width: 100%;
                padding: 9px;
                color: #fff;
                background:
                    linear-gradient(
                        180deg,
                        #081321,
                        #07101c
                    );
                border: 1px solid #2b405f;
                border-radius: 6px;
                outline: none;
                font-size: 11px;
                font-weight: bold;
                transition:
                    border-color .15s ease,
                    box-shadow .15s ease;
            }

            #${CONFIG.panelId} input:focus {
                border-color: #55e6d3;
                box-shadow:
                    0 0 0 2px rgba(85,230,211,.12);
            }

            #${CONFIG.panelId}
            .data-section {
                margin: 0 12px 10px;
                overflow: hidden;
                background:
                    linear-gradient(
                        145deg,
                        #101926,
                        #0b121e
                    );
                border: 1px solid #1d2c41;
                border-radius: 10px;
            }

            #${CONFIG.panelId}
            .data-section-heading {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 9px 10px;
                background:
                    rgba(255,255,255,.025);
                border-bottom:
                    1px solid rgba(255,255,255,.05);
            }

            #${CONFIG.panelId}
            .section-icon {
                display: grid;
                place-items: center;
                width: 25px;
                height: 25px;
                color: #092018;
                background: #55e6d3;
                border-radius: 7px;
                font-size: 10px;
                font-weight: 900;
            }

            #${CONFIG.panelId}
            .section-icon.current {
                color: #071626;
                background: #69b7ff;
            }

            #${CONFIG.panelId}
            .data-section-heading > div:last-child {
                display: flex;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .data-section-heading strong {
                color: #dce6f3;
                font-size: 10px;
            }

            #${CONFIG.panelId}
            .data-section-heading span {
                margin-top: 2px;
                color: #65738a;
                font-size: 7px;
            }

            #${CONFIG.panelId}
            .input-stat-grid {
                display: grid;
                grid-template-columns:
                    repeat(3, 1fr);
                gap: 6px;
                padding: 8px;
            }

            #${CONFIG.panelId}
            .stat-input-card {
                display: flex;
                flex-direction: column;
                gap: 5px;
                padding: 6px;
                background: #0b1421;
                border: 1px solid #1b2a3e;
                border-radius: 7px;
                transition:
                    border-color .15s ease,
                    background .15s ease;
            }

            #${CONFIG.panelId}
            .stat-input-card:focus-within {
                background: #0e1a2a;
                border-color: #365e78;
            }

            #${CONFIG.panelId}
            .stat-input-label {
                display: flex;
                align-items: center;
                gap: 4px;
            }

            #${CONFIG.panelId}
            .stat-input-label i {
                font-style: normal;
                font-size: 9px;
            }

            #${CONFIG.panelId}
            .stat-input-label span {
                color: #8390a5;
                font-size: 8px;
                font-weight: bold;
            }

            #${CONFIG.panelId}
            .stat-input-card input {
                padding: 6px;
                border-radius: 4px;
                font-size: 10px;
                text-align: center;
            }

            #${CONFIG.panelId}
            [data-stat="hp"] i {
                color: #ff6680;
            }

            #${CONFIG.panelId}
            [data-stat="atk"] i {
                color: #ffb45c;
            }

            #${CONFIG.panelId}
            [data-stat="def"] i {
                color: #65c8ff;
            }

            #${CONFIG.panelId}
            [data-stat="spa"] i {
                color: #d985ff;
            }

            #${CONFIG.panelId}
            [data-stat="spd"] i {
                color: #6ee0a0;
            }

            #${CONFIG.panelId}
            [data-stat="vel"] i {
                color: #ffe36a;
            }

            #${CONFIG.panelId}
            .calculate-button {
                display: flex;
                align-items: center;
                gap: 9px;
                width: calc(100% - 24px);
                margin: 3px 12px 13px;
                padding: 10px;
                color: #fff;
                background:
                    linear-gradient(
                        135deg,
                        #357fdb,
                        #285eb5
                    );
                border: 1px solid #68a9ff;
                border-radius: 9px;
                cursor: pointer;
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,.18),
                    0 6px 15px rgba(30,90,180,.2);
                text-align: left;
                transition:
                    transform .15s ease,
                    filter .15s ease;
            }

            #${CONFIG.panelId}
            .calculate-button:hover {
                filter: brightness(1.1);
                transform: translateY(-1px);
            }

            #${CONFIG.panelId}
            .calculate-button:active {
                transform: translateY(1px);
            }

            #${CONFIG.panelId}
            .calculate-icon {
                display: grid;
                place-items: center;
                width: 31px;
                height: 31px;
                background: rgba(255,255,255,.12);
                border:
                    1px solid rgba(255,255,255,.15);
                border-radius: 8px;
                font-size: 17px;
            }

            #${CONFIG.panelId}
            .calculate-button > span:nth-child(2) {
                display: flex;
                flex: 1;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .calculate-button strong {
                font-size: 11px;
            }

            #${CONFIG.panelId}
            .calculate-button small {
                margin-top: 2px;
                color: rgba(255,255,255,.65);
                font-size: 8px;
            }

            #${CONFIG.panelId}
            .calculate-button > b {
                font-size: 20px;
            }

            #${CONFIG.panelId}
            .result-wrapper {
                padding: 13px 12px 4px;
                background:
                    linear-gradient(
                        180deg,
                        #09121f,
                        #080e18
                    );
                border-top:
                    1px solid rgba(255,255,255,.06);
            }

            #${CONFIG.panelId}
            .result-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 9px;
            }

            #${CONFIG.panelId}
            .result-title > div {
                display: flex;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .result-eyebrow {
                color: #55e6d3;
                font-size: 7px;
                font-weight: bold;
                letter-spacing: 1.1px;
            }

            #${CONFIG.panelId}
            .result-title strong {
                margin-top: 3px;
                color: #dce6f3;
                font-size: 12px;
            }

            #${CONFIG.panelId}
            .result-check {
                display: grid;
                place-items: center;
                width: 25px;
                height: 25px;
                color: #062419;
                background: #55e6d3;
                border-radius: 50%;
                font-size: 12px;
                font-weight: 900;
            }

            #${CONFIG.panelId}
            .result-main-card {
                display: flex;
                align-items: center;
                gap: 13px;
                padding: 13px;
                background:
                    radial-gradient(
                        circle at top right,
                        rgba(85,230,211,.09),
                        transparent 45%
                    ),
                    linear-gradient(
                        145deg,
                        #0e1b2b,
                        #091321
                    );
                border: 1px solid #20384f;
                border-radius: 12px;
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,.04);
            }

            #${CONFIG.panelId}
            .score-circle {
                position: relative;
                display: grid;
                place-items: center;
                flex: 0 0 auto;
                width: 90px;
                height: 90px;
                border-radius: 50%;
                background:
                    conic-gradient(
                        var(--score-color)
                        var(--score),
                        #1c2a3b 0deg
                    );
                box-shadow:
                    0 0 25px
                    color-mix(
                        in srgb,
                        var(--score-color) 25%,
                        transparent
                    );
            }

            #${CONFIG.panelId}
            .score-circle::before {
                content: "";
                position: absolute;
                inset: 7px;
                background:
                    radial-gradient(
                        circle at 40% 30%,
                        #15263a,
                        #08111e 70%
                    );
                border:
                    1px solid rgba(255,255,255,.07);
                border-radius: 50%;
            }

            #${CONFIG.panelId}
            .score-circle > div {
                position: relative;
                z-index: 1;
                display: flex;
                flex-direction: column;
                align-items: center;
            }

            #${CONFIG.panelId}
            .score-circle strong {
                color: #fff;
                font-size: 22px;
                line-height: 1;
            }

            #${CONFIG.panelId}
            .score-circle span {
                margin-top: 3px;
                color: #78879c;
                font-size: 7px;
                text-transform: uppercase;
            }

            #${CONFIG.panelId}
            .result-description {
                display: flex;
                flex: 1;
                flex-direction: column;
                min-width: 0;
            }

            #${CONFIG.panelId}
            .result-description small {
                color: #65758b;
                font-size: 7px;
                letter-spacing: 1px;
            }

            #${CONFIG.panelId}
            .result-description strong {
                margin-top: 4px;
                font-size: 16px;
            }

            #${CONFIG.panelId}
            .result-description p {
                margin: 6px 0 0;
                color: #8795aa;
                font-size: 9px;
                line-height: 1.4;
            }

            #${CONFIG.panelId}
            .result-metrics {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
                margin-top: 8px;
            }

            #${CONFIG.panelId}
            .result-metric {
                display: flex;
                align-items: center;
                gap: 7px;
                padding: 8px;
                background: #0c1624;
                border: 1px solid #1b2d42;
                border-radius: 8px;
            }

            #${CONFIG.panelId}
            .result-metric:last-child {
                grid-column: 1 / -1;
            }

            #${CONFIG.panelId}
            .metric-icon {
                display: grid;
                place-items: center;
                flex: 0 0 auto;
                width: 27px;
                height: 27px;
                border-radius: 7px;
                font-size: 9px;
                font-weight: 900;
            }

            #${CONFIG.panelId}
            .metric-icon.quality {
                color: #291d00;
                background: #f1c644;
            }

            #${CONFIG.panelId}
            .metric-icon.iv {
                color: #05201d;
                background: #55e6d3;
            }

            #${CONFIG.panelId}
            .metric-icon.power {
                color: #221606;
                background: #ffb35c;
            }

            #${CONFIG.panelId}
            .result-metric > div {
                display: flex;
                flex-direction: column;
                min-width: 0;
            }

            #${CONFIG.panelId}
            .result-metric small {
                color: #68778d;
                font-size: 6px;
                letter-spacing: .8px;
            }

            #${CONFIG.panelId}
            .result-metric strong {
                margin-top: 1px;
                color: #edf4ff;
                font-size: 12px;
            }

            #${CONFIG.panelId}
            .result-metric > div > span {
                color: #66758a;
                font-size: 7px;
            }

            #${CONFIG.panelId}
            .overall-progress {
                margin-top: 8px;
                padding: 9px 10px;
                background: #0b1522;
                border: 1px solid #192b3f;
                border-radius: 8px;
            }

            #${CONFIG.panelId}
            .overall-progress > div:first-child {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 7px;
            }

            #${CONFIG.panelId}
            .overall-progress span {
                color: #8795aa;
                font-size: 8px;
            }

            #${CONFIG.panelId}
            .overall-progress strong {
                color: #eaf2fc;
                font-size: 10px;
            }

            #${CONFIG.panelId}
            .overall-track {
                overflow: hidden;
                height: 7px;
                background: #1e2b3e;
                border-radius: 99px;
            }

            #${CONFIG.panelId}
            .overall-track div {
                height: 100%;
                border-radius: inherit;
                box-shadow:
                    0 0 8px rgba(85,230,211,.25);
            }

            #${CONFIG.panelId}
            .individual-section {
                padding: 10px 12px 12px;
                background: #080e18;
            }

            #${CONFIG.panelId}
            .individual-heading {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
            }

            #${CONFIG.panelId}
            .individual-heading > div {
                display: flex;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .individual-heading strong {
                color: #dfe8f4;
                font-size: 11px;
            }

            #${CONFIG.panelId}
            .individual-heading span {
                margin-top: 2px;
                color: #66758b;
                font-size: 7px;
            }

            #${CONFIG.panelId}
            .individual-total {
                padding: 4px 7px;
                color: #55e6d3 !important;
                background: rgba(85,230,211,.08);
                border: 1px solid rgba(85,230,211,.2);
                border-radius: 999px;
                font-size: 8px !important;
                font-weight: bold;
            }

            #${CONFIG.panelId}
            .iv-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 7px;
            }

            #${CONFIG.panelId}
            .iv-item {
                padding: 9px;
                background:
                    linear-gradient(
                        145deg,
                        #101a29,
                        #0b131f
                    );
                border: 1px solid #1e3046;
                border-radius: 9px;
                transition:
                    transform .15s ease,
                    border-color .15s ease;
            }

            #${CONFIG.panelId}
            .iv-item:hover {
                border-color: #34506e;
                transform: translateY(-1px);
            }

            #${CONFIG.panelId}
            .iv-item-top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 5px;
            }

            #${CONFIG.panelId}
            .iv-stat-name {
                display: flex;
                align-items: center;
                gap: 6px;
                min-width: 0;
            }

            #${CONFIG.panelId}
            .iv-stat-name > span {
                display: grid;
                place-items: center;
                flex: 0 0 auto;
                width: 23px;
                height: 23px;
                background: rgba(255,255,255,.05);
                border:
                    1px solid rgba(255,255,255,.06);
                border-radius: 6px;
                font-size: 11px;
            }

            #${CONFIG.panelId}
            .iv-stat-name > div {
                display: flex;
                min-width: 0;
                flex-direction: column;
            }

            #${CONFIG.panelId}
            .iv-stat-name strong {
                color: #e9f1fb;
                font-size: 11px;
            }

            #${CONFIG.panelId}
            .iv-stat-name small {
                overflow: hidden;
                color: #66758a;
                font-size: 8px;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            #${CONFIG.panelId}
            .iv-value {
                display: flex;
                align-items: baseline;
                flex: 0 0 auto;
            }

            #${CONFIG.panelId}
            .iv-value strong {
                color: #fff;
                font-size: 14px;
            }

            #${CONFIG.panelId}
            .iv-value span {
                color: #66758a;
                font-size: 9px;
            }

            #${CONFIG.panelId}
            .iv-track {
                overflow: hidden;
                height: 6px;
                margin-top: 8px;
                background: #202d3f;
                border-radius: 99px;
            }

            #${CONFIG.panelId}
            .iv-track div {
                height: 100%;
                border-radius: inherit;
            }

            #${CONFIG.panelId}
            .iv-item[data-stat="hp"]
            .iv-track div {
                background:
                    linear-gradient(
                        90deg,
                        #e94e6b,
                        #ff7f96
                    );
            }

            #${CONFIG.panelId}
            .iv-item[data-stat="atk"]
            .iv-track div {
                background:
                    linear-gradient(
                        90deg,
                        #e8873d,
                        #ffbd6c
                    );
            }

            #${CONFIG.panelId}
            .iv-item[data-stat="def"]
            .iv-track div {
                background:
                    linear-gradient(
                        90deg,
                        #3d95d9,
                        #68c6ff
                    );
            }

            #${CONFIG.panelId}
            .iv-item[data-stat="spa"]
            .iv-track div {
                background:
                    linear-gradient(
                        90deg,
                        #a653d7,
                        #dc8cff
                    );
            }

            #${CONFIG.panelId}
            .iv-item[data-stat="spd"]
            .iv-track div {
                background:
                    linear-gradient(
                        90deg,
                        #3fb875,
                        #75e3a7
                    );
            }

            #${CONFIG.panelId}
            .iv-item[data-stat="vel"]
            .iv-track div {
                background:
                    linear-gradient(
                        90deg,
                        #d3b02c,
                        #ffe36a
                    );
            }

            #${CONFIG.panelId}
            .iv-item-bottom {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-top: 6px;
            }

            #${CONFIG.panelId}
            .iv-item-bottom > span:last-child {
                color: #66758a;
                font-size: 10px;
            }

            #${CONFIG.panelId}
            .iv-rating {
                padding: 2px 6px;
                border-radius: 999px;
                font-size: 9px;
                font-weight: bold;
                text-transform: uppercase;
            }

            #${CONFIG.panelId}
            .iv-rating.perfect {
                color: #6af3aa;
                background: rgba(74,214,137,.1);
            }

            #${CONFIG.panelId}
            .iv-rating.great {
                color: #5ce0d2;
                background: rgba(85,230,211,.1);
            }

            #${CONFIG.panelId}
            .iv-rating.good {
                color: #70baff;
                background: rgba(105,183,255,.1);
            }

            #${CONFIG.panelId}
            .iv-rating.average {
                color: #f1c644;
                background: rgba(241,198,68,.1);
            }

            #${CONFIG.panelId}
            .iv-rating.low {
                color: #ff7a83;
                background: rgba(240,90,98,.1);
            }

            #${CONFIG.panelId}
            .warning {
                display: flex;
                flex-direction: column;
                gap: 3px;
                margin: 10px 12px;
                padding: 9px;
                color: #ffd77d;
                background: rgba(243,154,75,.12);
                border: 1px solid rgba(243,154,75,.4);
                border-radius: 7px;
                font-size: 9px;
                line-height: 1.4;
            }

            #${CONFIG.panelId}
            .warning strong {
                font-size: 9px;
            }

            #${CONFIG.panelId}
            .warning span {
                color: #d7a968;
                font-size: 8px;
            }

            #${CONFIG.panelId}
            .analysis-note {
                display: flex;
                align-items: flex-start;
                gap: 6px;
                margin: 0 12px 12px;
                padding: 8px;
                color: #67768b;
                background: #0b131f;
                border: 1px solid #1b2b3f;
                border-radius: 7px;
            }

            #${CONFIG.panelId}
            .analysis-note span {
                color: #55e6d3;
                font-size: 10px;
            }

            #${CONFIG.panelId}
            .analysis-note p {
                margin: 0;
                font-size: 8px;
                line-height: 1.4;
            }

            #${CONFIG.panelId}
            .footer {
                padding: 5px;
                color: #5f6877;
                background: rgba(0,0,0,.22);
                font-size: 8px;
                letter-spacing: 1px;
                text-align: center;
                text-transform: uppercase;
            }

            #moves-panel {
                position: fixed;
                width: 300px;
                z-index: 2147483646;
                display: flex;
                flex-direction: column;
                color: #f7f7f7;
                background:
                    radial-gradient(
                        circle at top right,
                        rgba(67, 141, 243, 0.05),
                        transparent 42%
                    ),
                    linear-gradient(
                        165deg,
                        #151923 0%,
                        #0c0f16 55%,
                        #080a0f 100%
                    );
                border: 2px solid #f1c644;
                border-radius: 16px;
                box-shadow:
                    0 0 0 3px rgba(0,0,0,.75),
                    0 14px 40px rgba(0,0,0,.7);
                font-family: Arial, Helvetica, sans-serif;
                overflow: hidden;
                box-sizing: border-box;
            }

            #moves-panel * {
                box-sizing: border-box;
            }

            .moves-header {
                display: flex;
                align-items: center;
                min-height: 40px;
                padding: 10px 12px;
                background: linear-gradient(180deg, #1f2535, #121620);
                border-bottom: 2px solid #151515;
            }

            .moves-header strong {
                color: #ffd84f;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: .5px;
            }

            .moves-body {
                flex: 1;
                overflow-y: auto;
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                scrollbar-width: thin;
                scrollbar-color: #ca3035 #111722;
            }

            .move-card {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 10px;
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(255,255,255,0.05);
                border-radius: 10px;
                gap: 8px;
                transition: border-color 0.15s ease, background 0.15s ease;
            }

            .move-card.active {
                border-color: #f1c644;
                background: rgba(241,198,68,0.04);
                box-shadow: 0 0 10px rgba(241,198,68,0.1);
            }

            .move-card.taken {
                border-color: rgba(240,90,98,0.06);
                background: rgba(240,90,98,0.02);
            }

            #items-panel {
                position: fixed;
                width: 360px;
                z-index: 2147483646;
                display: flex;
                flex-direction: column;
                color: #f7f7f7;
                background:
                    radial-gradient(
                        circle at top right,
                        rgba(241, 198, 68, 0.08),
                        transparent 42%
                    ),
                    linear-gradient(
                        165deg,
                        #151923 0%,
                        #0c0f16 55%,
                        #080a0f 100%
                    );
                border: 2px solid #f1c644;
                border-radius: 16px;
                box-shadow:
                    0 0 0 3px rgba(0,0,0,.75),
                    0 14px 40px rgba(0,0,0,.7);
                font-family: Arial, Helvetica, sans-serif;
                overflow: hidden;
                box-sizing: border-box;
            }

            #items-panel * {
                box-sizing: border-box;
            }

            .items-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                min-height: 40px;
                padding: 10px 12px;
                background: linear-gradient(180deg, #1f2535, #121620);
                border-bottom: 2px solid #151515;
            }

            .items-body {
                flex: 1;
                overflow-y: auto;
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                scrollbar-width: thin;
                scrollbar-color: #f1c644 #111722;
            }

            .item-row-card:hover {
                background: rgba(241,198,68,0.08) !important;
                border-color: rgba(241,198,68,0.4) !important;
            }

            .drop-poke-row:hover {
                background: rgba(147,197,253,0.1) !important;
                border-color: rgba(147,197,253,0.3) !important;
            }

            .type-badge {
                display: inline-block;
                padding: 2px 7px;
                border-radius: 99px;
                font-size: 8px;
                font-weight: bold;
                color: #fff;
                text-shadow: 0 1px 1px rgba(0,0,0,0.5);
                box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15);
                line-height: 1.2;
                text-align: center;
            }

            input.flat-stat-input::-webkit-outer-spin-button,
            input.flat-stat-input::-webkit-inner-spin-button {
                -webkit-appearance: none;
                margin: 0;
            }

            @keyframes spin {
                to {
                    transform: rotate(360deg);
                }
            }

            /* ========================================================================= */
            /* ESTILOS DA ABA ANÁLISE DE CAPTURA (.catch-*)                              */
            /* ========================================================================= */
            #tab-captura-inner {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 10px;
                background: #090d16;
                color: #e2e8f0;
                font-family: inherit;
                box-sizing: border-box;
            }

            .catch-controls-bar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: wrap;
                gap: 8px;
                background: #111827;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 8px 12px;
            }

            .catch-status-badge {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 10px;
                font-weight: bold;
                color: #34d399;
                background: rgba(52, 211, 153, 0.12);
                border: 1px solid rgba(52, 211, 153, 0.3);
                padding: 2px 8px;
                border-radius: 99px;
            }

            .catch-status-badge.paused {
                color: #fbbf24;
                background: rgba(251, 191, 36, 0.12);
                border-color: rgba(251, 191, 36, 0.3);
            }

            .catch-btn-group {
                display: flex;
                align-items: center;
                gap: 5px;
                flex-wrap: wrap;
            }

            .catch-btn {
                background: #1e293b;
                color: #e2e8f0;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 6px;
                padding: 4px 9px;
                font-size: 9.5px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s ease;
                display: inline-flex;
                align-items: center;
                gap: 4px;
            }

            .catch-btn:hover {
                background: #334155;
                border-color: rgba(255, 255, 255, 0.25);
                color: #fff;
            }

            .catch-btn.primary {
                background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
                border-color: #3b82f6;
                color: #fff;
            }

            .catch-btn.primary:hover {
                background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            }

            .catch-btn.danger {
                background: linear-gradient(135deg, #991b1b 0%, #7f1d1d 100%);
                border-color: #ef4444;
                color: #fff;
            }

            .catch-btn.danger:hover {
                background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
            }

            .catch-cards-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
                gap: 6px;
            }

            .catch-stat-card {
                background: linear-gradient(135deg, #131c2d 0%, #0d1422 100%);
                border: 1px solid rgba(255, 255, 255, 0.07);
                border-radius: 8px;
                padding: 7px 8px;
                display: flex;
                flex-direction: column;
                gap: 2px;
                box-sizing: border-box;
            }

            .catch-stat-card .card-lbl {
                font-size: 8px;
                font-weight: bold;
                color: #94a3b8;
                text-transform: uppercase;
                letter-spacing: 0.4px;
            }

            .catch-stat-card .card-val {
                font-size: 13px;
                font-weight: bold;
                color: #fff;
                line-height: 1.2;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .catch-stat-card .card-sub {
                font-size: 7.5px;
                color: #64748b;
            }

            .catch-validation-panel {
                background: #0f172a;
                border: 1px solid rgba(56, 189, 248, 0.2);
                border-radius: 8px;
                padding: 8px 12px;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .catch-validation-title {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 10.5px;
                font-weight: bold;
                color: #38bdf8;
            }

            .catch-meta-progress-box {
                background: #111827;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 8px 12px;
            }

            .catch-charts-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                gap: 8px;
            }

            .catch-chart-card {
                background: #0f172a;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 8px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }

            .catch-chart-header {
                font-size: 10px;
                font-weight: bold;
                color: #cbd5e1;
            }

            .catch-filters-bar {
                background: #111827;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 8px 10px;
            }

            .catch-input, .catch-select {
                background: #090d16;
                color: #e2e8f0;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 5px;
                padding: 3px 6px;
                font-size: 9.5px;
                outline: none;
                box-sizing: border-box;
            }

            .catch-input:focus, .catch-select:focus {
                border-color: #38bdf8;
            }

            .catch-table-wrapper {
                overflow-x: auto;
                background: #0f172a;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                max-height: 300px;
                overflow-y: auto;
            }

            .catch-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 9.5px;
                color: #e2e8f0;
            }

            .catch-table th {
                background: #1e293b;
                color: #94a3b8;
                font-weight: bold;
                text-align: left;
                padding: 6px 8px;
                position: sticky;
                top: 0;
                z-index: 10;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }

            .catch-table td {
                padding: 5px 8px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            }

            .catch-table-row {
                cursor: pointer;
                transition: background 0.12s ease;
            }

            .catch-table-row:hover {
                background: rgba(56, 189, 248, 0.08) !important;
            }

            .catch-badge {
                display: inline-block;
                padding: 1px 6px;
                border-radius: 99px;
                font-size: 8px;
                font-weight: bold;
                line-height: 1.3;
            }

            .catch-badge.error { background: rgba(248, 113, 113, 0.15); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); }
            .catch-badge.warning { background: rgba(251, 191, 36, 0.15); color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); }
            .catch-badge.info { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
            .catch-badge.teal { background: rgba(45, 212, 191, 0.15); color: #2dd4bf; border: 1px solid rgba(45, 212, 191, 0.3); }
            .catch-badge.success { background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); }

            .catch-modal-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.75);
                backdrop-filter: blur(3px);
                z-index: 10000;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 15px;
            }

            .catch-modal-content {
                background: #0f172a;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 10px;
                width: 100%;
                max-width: 580px;
                max-height: 85vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);
                overflow: hidden;
            }

            .catch-modal-header {
                background: #1e293b;
                padding: 10px 14px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            }

            .catch-modal-header h3 {
                margin: 0;
                font-size: 12px;
                color: #fff;
            }

            .catch-modal-close {
                background: transparent;
                border: none;
                color: #94a3b8;
                font-size: 18px;
                cursor: pointer;
                line-height: 1;
            }

            .catch-modal-close:hover {
                color: #fff;
            }

            .catch-modal-body {
                padding: 12px;
                overflow-y: auto;
            }
        `;
    }

    // =========================================================================
    // NOVO: SISTEMA DE LEITURA DO MERCADO GLOBAL (VIA CLIQUE NA LINHA)
    // =========================================================================
    function processarDadosMercado() {
        const lateral = document.querySelector("aside.mkt2-details");
        if (!lateral) return;

        // 1. Nome e Nível (Ex: "Geodude Lv.1")
        const nomeNivelTexto = lateral.querySelector(".mkt2-details-name")?.innerText?.trim() || "";
        if (!nomeNivelTexto) return;

        const nivelMatch = nomeNivelTexto.match(/Lv\.?\s*(\d+)/i);
        const nivel = nivelMatch ? Number(nivelMatch[1]) : 1;
        // Remove o "Lv.X" para isolar o nome limpo
        const nome = nomeNivelTexto.replace(/Lv\.?\s*\d+/i, "").trim();

        // 2. Qualidade / Multiplicador (Ex: "Lendária ×1.70" ou "Lendária x1.70")
        const qualidadeTexto = lateral.innerText.match(/Raridade\s+([^\n]+)/i)?.[1]?.trim() || "";
        const multiplicador = numeroDecimal(qualidadeTexto?.match(/(?:×|x)\s*([\d.,]+)/i)?.[1]) || 1.0;

        // 3. IV Total observado (Ex: "148/182" ou "131/192")
        const cardAtivo = document.querySelector(".mkt2-card.clickable.active, .mkt2-trow.clickable.active, .mkt2-card.clickable, .mkt2-trow.clickable");
        const textoBusca = (lateral.innerText || "") + " " + (cardAtivo ? cardAtivo.innerText : "");
        const ivMatch = textoBusca.match(/IV\s*(\d+)\s*\/\s*(\d+)/i) || textoBusca.match(/IV\s*(\d+)/i);
        const ivAtual = ivMatch ? Number(ivMatch[1]) : null;
        const ivMaximo = ivMatch && ivMatch[2] ? Number(ivMatch[2]) : 192;

        // 4. Poder
        const poderMatch = lateral.innerText.match(/Poder\s*.*?(\d+)/i);
        const poder = poderMatch ? Number(poderMatch[1]) : null;

        // 5. Tipos (Mapeia as badges de tipo dentro da lateral)
        const tipos = Array.from(lateral.querySelectorAll(".mkt2-card-badges span, .mkt2-statlist span"))
            .map(el => el.innerText.trim())
            .filter(txt => txt && !/Poder|Ativo|Somente/i.test(txt));

        // 6. Atributos Atuais (Stats vindos da grid de células .mkt2-statcell)
        const statsCelas = Array.from(lateral.querySelectorAll(".mkt2-stats .mkt2-statcell"));
        const obterValorCela = (index) => {
            if (!statsCelas[index]) return null;
            // Pega o número que aparece na célula do atributo
            const numMatch = statsCelas[index].innerText.match(/(\d+)/);
            return numMatch ? Number(numMatch[1]) : null;
        };

        // Ordem padrão baseada na exibição comum do jogo (Geralmente: HP, Atk, Def, SpA, SpD, Vel)
        const hp = obterValorCela(0);
        const atk = obterValorCela(1);
        const def = obterValorCela(2);
        const spa = obterValorCela(3);
        const spd = obterValorCela(4);
        const vel = obterValorCela(5);

        // Monta o objeto estruturado identicamente ao seu leitor original
        const pokemon = {
            nome,
            tipos,
            ativo: false,
            nivel,
            qualidade: qualidadeTexto || "Comum",
            multiplicadorQualidade: multiplicador,
            ivAtual,
            ivMaximo,
            hp, atk, def, spa, spd, vel,
            poder
        };

        // Reseta o cache de golpes da caçada se mudar de Pokémon
        if (ultimoPokemon && normalizarNomePokemon(ultimoPokemon.nome) !== normalizarNomePokemon(pokemon.nome)) {
            danoPorGolpe.clear();
            ultimoGolpeUsado = null;
        }

        ultimoTexto = `MKT-${nome}-${nivel}-${poder}`; // Evita travamento de repetição idêntica
        ultimoPokemon = pokemon;

        const painel = document.getElementById(CONFIG.panelId);
        if (painel) painel.style.display = "flex";

        // Alimenta todas as abas e atualiza seu painel lateral da Pokédex automaticamente!
        atualizarPainelLeitor(pokemon);
        carregarAnalise(pokemon);
        atualizarPainelMoves();
        atualizarPosicaoPainelMoves();
        atualizarPosicaoPainelItens();
        atualizarPainelComparacao();

        console.log("[Poké Leitor] Pokémon capturado do Mercado Global:", pokemon);
    }

    // =========================================================================
    // INICIALIZADORES E OBSERVERS ADAPTADOS
    // =========================================================================
    function iniciarEscutasEventos() {
        // Escuta Cliques no Mercado Global usando Event Delegation (suporta modo linhas e cards)
        document.addEventListener("click", (evento) => {
            const clicado = evento.target.closest(".mkt2-trow.clickable, .mkt2-card.clickable");
            if (clicado) {
                // Pequeno delay de 60ms para esperar o jogo renderizar os dados na barra lateral
                setTimeout(processarDadosMercado, 60);
            }
        });

        // Atalho de Teclado (Alt + P) para alternar visibilidade da extensão a qualquer momento
        document.addEventListener("keydown", (evento) => {
            if (evento.altKey && (evento.key === "p" || evento.key === "P")) {
                evento.preventDefault();
                alternarVisibilidadePainel();
            }
        });
    }

    function observarLogDeCapturas() {
        let clogListObserver = null;
        let filtrandoClog = false;

        const LISTA_RARIDADES = [
            { id: "fraca", nome: "Fraca", cor: "#9e9e9e" },
            { id: "comum", nome: "Comum", cor: "#e0e0e0" },
            { id: "incomum", nome: "Incomum", cor: "#4caf50" },
            { id: "rara", nome: "Rara", cor: "#2196f3" },
            { id: "épica", nome: "Épica", cor: "#ab47bc" },
            { id: "lendária", nome: "Lendária", cor: "#ffb300" },
            { id: "mítica", nome: "Mítica", cor: "#f44336" },
            { id: "anciã", nome: "Anciã", cor: "#8d6e63" },
            { id: "divina", nome: "Divina", cor: "#00e5ff" }
        ];

        if (!window._clogRaridadesSelecionadas) {
            window._clogRaridadesSelecionadas = new Set(LISTA_RARIDADES.map(r => r.id));
        }
        const raridadesSelecionadas = window._clogRaridadesSelecionadas;

        function atualizarTextoBotaoRaridade() {
            const btnText = document.getElementById("clog-rarity-btn-text");
            if (!btnText) return;

            if (raridadesSelecionadas.size === LISTA_RARIDADES.length || raridadesSelecionadas.size === 0) {
                btnText.textContent = "Todas Raridades";
            } else if (raridadesSelecionadas.size === 1) {
                const idSel = Array.from(raridadesSelecionadas)[0];
                const item = LISTA_RARIDADES.find(r => r.id === idSel);
                btnText.textContent = item ? item.nome : "1 Raridade";
            } else {
                btnText.textContent = `${raridadesSelecionadas.size} Raridades`;
            }
        }

        function aplicarFiltroClog() {
            if (filtrandoClog) return;
            const clogWindow = document.querySelector(".clog-window");
            if (!clogWindow) return;

            const ivFilterVal = parseInt(document.getElementById("clog-filter-iv")?.value || "0", 10);
            const todasSelecionadas = raridadesSelecionadas.size === LISTA_RARIDADES.length || raridadesSelecionadas.size === 0;

            const rows = clogWindow.querySelectorAll(".clog-list .clog-row");
            if (!rows.length) return;

            filtrandoClog = true;
            rows.forEach(row => {
                const metaEl = row.querySelector(".clog-meta");
                const fullText = (row.innerText || "").trim();
                const metaText = metaEl ? (metaEl.innerText || "").trim() : fullText;

                const parts = metaText.split("·").map(s => s.trim());
                const firstPart = (parts[0] ? parts[0] : metaText.split(/\s+/)[0] || "").toLowerCase().trim();

                let rowRarity = null;
                const foundDirect = LISTA_RARIDADES.find(r => r.id === firstPart);
                if (foundDirect) {
                    rowRarity = foundDirect.id;
                } else {
                    const textLower = fullText.toLowerCase();
                    const foundSub = LISTA_RARIDADES.find(r => textLower.includes(r.id));
                    if (foundSub) rowRarity = foundSub.id;
                }

                const ivMatch = metaText.match(/IV\s*(\d+)/i) || fullText.match(/IV\s*(\d+)/i);
                const ivVal = ivMatch ? parseInt(ivMatch[1], 10) : 0;

                const matchesRarity = todasSelecionadas || (rowRarity ? raridadesSelecionadas.has(rowRarity) : true);
                const matchesIv = !ivFilterVal || ivVal >= ivFilterVal;

                if (matchesRarity && matchesIv) {
                    row.style.setProperty("display", "", "important");
                } else {
                    row.style.setProperty("display", "none", "important");
                }
            });
            filtrandoClog = false;
        }

        // Garante que o menu exista no body (evita overflow: hidden do modal)
        function obterOuCriarMenuDropGlobal() {
            let menuDrop = document.getElementById("clog-rarity-menu-global");
            if (!menuDrop) {
                menuDrop = document.createElement("div");
                menuDrop.id = "clog-rarity-menu-global";
                menuDrop.style.cssText = "display: none; position: fixed; width: 200px; background: #111823 !important; border: 1px solid rgba(255,255,255,0.3) !important; border-radius: 6px !important; box-shadow: 0 12px 36px rgba(0,0,0,0.95) !important; padding: 6px !important; z-index: 9999999 !important; box-sizing: border-box;";
                menuDrop.innerHTML = `
                    <div style="display: flex; justify-content: space-between; padding: 2px 4px 6px 4px; border-bottom: 1px solid rgba(255,255,255,0.15); margin-bottom: 4px;">
                        <button id="clog-rarity-select-all" type="button" style="background: none; border: none; color: #4fc3f7; font-size: 10px; font-weight: bold; cursor: pointer; padding: 0; outline: none;">Marcar Todos</button>
                        <button id="clog-rarity-clear-all" type="button" style="background: none; border: none; color: #ff8a80; font-size: 10px; font-weight: bold; cursor: pointer; padding: 0; outline: none;">Desmarcar</button>
                    </div>
                    <div id="clog-rarity-options" style="max-height: 230px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;">
                    </div>
                `;
                document.body.appendChild(menuDrop);

                const optionsContainer = menuDrop.querySelector("#clog-rarity-options");
                const btnSelectAll = menuDrop.querySelector("#clog-rarity-select-all");
                const btnClearAll = menuDrop.querySelector("#clog-rarity-clear-all");

                LISTA_RARIDADES.forEach(r => {
                    const itemLabel = document.createElement("label");
                    itemLabel.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 11px; color: #eee; cursor: pointer; user-select: none; border-radius: 4px; transition: background 0.15s;";
                    itemLabel.onmouseover = () => itemLabel.style.background = "rgba(255,255,255,0.12)";
                    itemLabel.onmouseout = () => itemLabel.style.background = "transparent";

                    const isChecked = raridadesSelecionadas.has(r.id);
                    itemLabel.innerHTML = `
                        <input type="checkbox" value="${r.id}" ${isChecked ? "checked" : ""} style="cursor: pointer; accent-color: #2196f3; width: 14px; height: 14px; margin: 0; flex-shrink: 0;">
                        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${r.cor}; flex-shrink: 0;"></span>
                        <span style="flex: 1; font-weight: 500;">${r.nome}</span>
                    `;

                    const chk = itemLabel.querySelector("input");
                    chk.addEventListener("change", (e) => {
                        e.stopPropagation();
                        if (chk.checked) {
                            raridadesSelecionadas.add(r.id);
                        } else {
                            raridadesSelecionadas.delete(r.id);
                        }
                        atualizarTextoBotaoRaridade();
                        aplicarFiltroClog();
                    });

                    optionsContainer.appendChild(itemLabel);
                });

                menuDrop.addEventListener("click", (e) => e.stopPropagation());

                btnSelectAll.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    raridadesSelecionadas.clear();
                    LISTA_RARIDADES.forEach(r => raridadesSelecionadas.add(r.id));
                    optionsContainer.querySelectorAll("input[type='checkbox']").forEach(chk => chk.checked = true);
                    atualizarTextoBotaoRaridade();
                    aplicarFiltroClog();
                });

                btnClearAll.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    raridadesSelecionadas.clear();
                    optionsContainer.querySelectorAll("input[type='checkbox']").forEach(chk => chk.checked = false);
                    atualizarTextoBotaoRaridade();
                    aplicarFiltroClog();
                });
            }
            return menuDrop;
        }

        function verificarEInjetarFiltroClog() {
            const clogWindow = document.querySelector(".clog-window");
            const menuDrop = document.getElementById("clog-rarity-menu-global");

            if (!clogWindow) {
                if (menuDrop) menuDrop.style.display = "none";
                if (clogListObserver) {
                    clogListObserver.disconnect();
                    clogListObserver = null;
                }
                return;
            }

            // Garante altura mínima do clog-list para evitar colapso da janela quando há poucas linhas
            const clogList = clogWindow.querySelector(".clog-list");
            if (clogList) {
                clogList.style.setProperty("min-height", "180px", "important");
            }

            // Injeta a barra de filtro se ainda não existir
            if (!document.getElementById("clog-filter-rarity-wrapper")) {
                const head = clogWindow.querySelector(".clog-head") || clogWindow.querySelector(".clog-title");
                if (head) {
                    const filterBar = document.createElement("div");
                    filterBar.className = "clog-filter-bar";
                    filterBar.style.cssText = "display: flex; gap: 6px; padding: 6px 12px; background: rgba(0,0,0,0.4); border-bottom: 1px solid rgba(255,255,255,0.1); align-items: center; box-sizing: border-box; position: relative;";
                    filterBar.innerHTML = `
                        <div id="clog-filter-rarity-wrapper" style="flex: 1; position: relative;">
                            <button id="clog-rarity-dropdown-btn" type="button" style="width: 100%; background: #151d2a; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: #fff; font-size: 10px; padding: 4px 8px; outline: none; height: 24px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 4px; box-sizing: border-box;">
                                <span id="clog-rarity-btn-text">Todas Raridades</span>
                                <span style="font-size: 8px; opacity: 0.7;">▼</span>
                            </button>
                        </div>
                        <input type="number" id="clog-filter-iv" placeholder="IV Min (ex: 110)" style="width: 105px; background: #151d2a; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: #fff; font-size: 10px; padding: 3px 6px; outline: none; height: 24px; box-sizing: border-box;" min="0" max="192">
                    `;
                    head.insertAdjacentElement("afterend", filterBar);

                    const btnDrop = filterBar.querySelector("#clog-rarity-dropdown-btn");
                    const iInp = filterBar.querySelector("#clog-filter-iv");
                    const mDrop = obterOuCriarMenuDropGlobal();

                    atualizarTextoBotaoRaridade();

                    btnDrop.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const estaAberto = mDrop.style.display === "block";
                        if (estaAberto) {
                            mDrop.style.display = "none";
                        } else {
                            const rect = btnDrop.getBoundingClientRect();
                            mDrop.style.top = (rect.bottom + 4) + "px";
                            mDrop.style.left = rect.left + "px";
                            mDrop.style.display = "block";
                        }
                    });

                    const onDocClick = (e) => {
                        if (mDrop && !filterBar.contains(e.target) && !mDrop.contains(e.target)) {
                            mDrop.style.display = "none";
                        }
                    };
                    document.removeEventListener("click", window._clogRarityMenuDismiss);
                    window._clogRarityMenuDismiss = onDocClick;
                    document.addEventListener("click", onDocClick);

                    iInp.addEventListener("input", aplicarFiltroClog);
                }
            }

            // Observa a lista de capturas para aplicar o filtro dinamicamente quando novas linhas entram
            if (clogList && !clogListObserver) {
                clogListObserver = new MutationObserver(() => {
                    aplicarFiltroClog();
                });
                clogListObserver.observe(clogList, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ["style", "class"]
                });
                aplicarFiltroClog();
            } else if (clogList) {
                aplicarFiltroClog();
            }
        }

        setInterval(verificarEInjetarFiltroClog, 1000);
        verificarEInjetarFiltroClog();
    }

    const DAILY_GIFT_KEY = "justpokedex-daily-gift-claim-timestamp";
    const COOLDOWN_24H_MS = 24 * 60 * 60 * 1000;

    function obterTempoRestanteResgate() {
        try {
            const salvo = localStorage.getItem(DAILY_GIFT_KEY);
            if (!salvo) return 0;
            const timestamp = parseInt(salvo, 10);
            if (!Number.isFinite(timestamp)) return 0;
            const decorrido = Date.now() - timestamp;
            const restante = COOLDOWN_24H_MS - decorrido;
            return restante > 0 ? restante : 0;
        } catch (e) {
            return 0;
        }
    }

    function formatarTempoRestante(ms) {
        const totalSegundos = Math.max(0, Math.floor(ms / 1000));
        const horas = Math.floor(totalSegundos / 3600);
        const minutos = Math.floor((totalSegundos % 3600) / 60);
        const segundos = totalSegundos % 60;
        if (horas > 0) {
            return `${horas}h ${minutos}m`;
        }
        if (minutos > 0) {
            return `${minutos}m ${segundos}s`;
        }
        return `${segundos}s`;
    }

    function extrairTempoMsDeTexto(texto) {
        if (!texto) return 0;
        // Padrão 14:30:15 (hh:mm:ss)
        const matchHMS = texto.match(/(\d{1,2}):(\d{2}):(\d{2})/);
        if (matchHMS) {
            const h = parseInt(matchHMS[1], 10);
            const m = parseInt(matchHMS[2], 10);
            const s = parseInt(matchHMS[3], 10);
            return ((h * 3600) + (m * 60) + s) * 1000;
        }
        // Padrão 14h 30m ou 14h
        const matchHM = texto.match(/(\d{1,2})\s*h\s*(?:(\d{1,2})\s*m)?/i);
        if (matchHM) {
            const h = parseInt(matchHM[1], 10);
            const m = matchHM[2] ? parseInt(matchHM[2], 10) : 0;
            return ((h * 3600) + (m * 60)) * 1000;
        }
        // Padrão 45m 12s ou 45m
        const matchMS = texto.match(/(\d{1,2})\s*m\s*(?:(\d{1,2})\s*s)?/i);
        if (matchMS) {
            const m = parseInt(matchMS[1], 10);
            const s = matchMS[2] ? parseInt(matchMS[2], 10) : 0;
            return ((m * 60) + s) * 1000;
        }
        return 0;
    }

    function limparResgateDiarioHoje() {
        try {
            localStorage.removeItem(DAILY_GIFT_KEY);
        } catch (e) { }
        atualizarBannerResgateDiario();
    }

    function atualizarBannerResgateDiario() {
        const banner = document.getElementById("daily-gift-banner");
        if (!banner) return;

        const restante = obterTempoRestanteResgate();

        if (restante > 0) {
            banner.style.background = "linear-gradient(135deg, rgba(76,175,80,0.12) 0%, rgba(46,125,50,0.05) 100%)";
            banner.style.cursor = "default";
            banner.title = `Próximo resgate diário em ${formatarTempoRestante(restante)}`;
            banner.innerHTML = `
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden;">
                    <span style="font-size: 11px;">⏳</span>
                    <strong style="color: #81c784; font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Próximo resgate em ${formatarTempoRestante(restante)}">${formatarTempoRestante(restante)}</strong>
                </div>
                <span style="color: #66bb6a; font-size: 8.5px; font-weight: bold; background: rgba(0,0,0,0.25); padding: 1px 4px; border-radius: 3px; flex-shrink: 0;">24h</span>
            `;
        } else {
            banner.style.background = "linear-gradient(135deg, rgba(241,198,68,0.18) 0%, rgba(180,120,20,0.15) 100%)";
            banner.style.cursor = "pointer";
            banner.title = "Clique para lembrar de abrir o Daily Gift no jogo";
            banner.innerHTML = `
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden;">
                    <span style="font-size: 11px;">🎁</span>
                    <strong style="color: #ffe984; font-size: 9.5px; white-space: nowrap;">Daily Gift</strong>
                </div>
                <span style="color: #ca9e00; font-size: 8.5px; font-weight: bold; background: rgba(241,198,68,0.2); border: 1px solid rgba(241,198,68,0.3); padding: 1px 5px; border-radius: 3px; flex-shrink: 0;">Resgatar</span>
            `;
            if (!banner.dataset.pokedexClickObserved) {
                banner.dataset.pokedexClickObserved = "true";
                banner.addEventListener("click", () => {
                    alert("🎁 Lembrete JustPokédex:\nAbra a janela de 'Daily Gift' no jogo para resgatar sua recompensa diária!");
                });
            }
        }
    }

    function observarResgateDiario() {
        function verificarBotaoResgate() {
            const btn = document.querySelector("button.dg-resgatar");
            if (btn) {
                const text = btn.innerText || btn.textContent || "";
                const textLower = text.toLowerCase();
                const isDisabled = btn.hasAttribute("disabled") || btn.disabled || textLower.includes("coletado") || textLower.includes("aguarde");

                if (!isDisabled) {
                    limparResgateDiarioHoje();
                } else {
                    const tempoExtraido = extrairTempoMsDeTexto(text);
                    if (tempoExtraido > 0) {
                        const tsSincronizado = Date.now() - (COOLDOWN_24H_MS - tempoExtraido);
                        try {
                            localStorage.setItem(DAILY_GIFT_KEY, String(tsSincronizado));
                        } catch (e) { }
                    }
                }

                if (!btn.dataset.pokedexObserved) {
                    btn.dataset.pokedexObserved = "true";
                    btn.addEventListener("click", () => {
                        try {
                            localStorage.setItem(DAILY_GIFT_KEY, String(Date.now()));
                        } catch (e) { }
                        setTimeout(atualizarBannerResgateDiario, 100);
                    });
                }
            }
        }

        // Verificação periódica da janela do jogo (2s)
        setInterval(verificarBotaoResgate, 2000);

        // Atualização em tempo real do timer na UI (1s) baixando conforme o tempo passa
        setInterval(atualizarBannerResgateDiario, 1000);

        document.addEventListener("click", (e) => {
            if (e.target?.closest("button.dg-resgatar")) {
                try {
                    localStorage.setItem(DAILY_GIFT_KEY, String(Date.now()));
                } catch (err) { }
                setTimeout(atualizarBannerResgateDiario, 100);
            }
        });

        verificarBotaoResgate();
        atualizarBannerResgateDiario();
    }

    function atualizarBannerDetectorShiny() {
        const banner = document.getElementById("shiny-detector-banner");
        if (!banner) return;

        const countBadge = contadorShinies > 0 ? `<span style="background: rgba(255,193,7,0.2); border: 1px solid rgba(255,193,7,0.4); color: #ffd54f; font-size: 8.5px; font-weight: bold; padding: 0 4px; border-radius: 3px;" title="Total de Shinies detectados">${contadorShinies}</span>` : "";

        const soundIcon = shinySoundEnabled ? "🔊" : "🔇";
        const soundTitle = shinySoundEnabled ? "Som do Shiny: ATIVADO (Clique para mutar/desativar)" : "Som do Shiny: MUTADO (Clique para ativar)";
        const soundOpacity = shinySoundEnabled ? "1" : "0.45";

        if (shinyDetectadoNoMapa) {
            banner.style.background = "linear-gradient(135deg, rgba(255,87,34,0.35) 0%, rgba(244,67,54,0.25) 100%)";
            banner.style.boxShadow = "inset 0 0 8px rgba(255,87,34,0.4)";
            banner.style.cursor = "pointer";
            banner.title = "Clique para confirmar e dispensar este alerta de Shiny";
            banner.innerHTML = `
                <div style="display: flex; align-items: center; gap: 3px; min-width: 0; overflow: hidden; animation: pulse 1s infinite alternate;">
                    <span style="font-size: 11px;">✨</span>
                    <strong style="color: #ffe0b2; font-size: 9.5px; white-space: nowrap;">SHINY!</strong>
                    ${countBadge}
                </div>
                <div style="display: flex; align-items: center; gap: 3px; flex-shrink: 0;">
                    <button id="btn-tocar-som-shiny" type="button" style="background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); color: #fff; font-size: 8.5px; font-weight: bold; padding: 1px 4px; border-radius: 3px; cursor: pointer; outline: none; opacity: ${soundOpacity};" title="${soundTitle}">${soundIcon}</button>
                    ${contadorShinies > 0 ? `<button id="btn-reset-shiny-counter" type="button" style="background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); color: #fff; font-size: 8.5px; padding: 0 3px; border-radius: 3px; cursor: pointer; line-height: 1.2;" title="Zerar contador">🔄</button>` : ""}
                    <button id="btn-limpar-shiny" type="button" style="background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.4); color: #fff; font-size: 8.5px; font-weight: bold; padding: 1px 4px; border-radius: 3px; cursor: pointer; outline: none; flex-shrink: 0;">OK</button>
                </div>
            `;

            const btnSom = banner.querySelector("#btn-tocar-som-shiny");
            if (btnSom) {
                btnSom.onclick = (e) => {
                    e.stopPropagation();
                    toggleSomShiny();
                };
            }

            const btnResetActive = banner.querySelector("#btn-reset-shiny-counter");
            if (btnResetActive) {
                btnResetActive.onclick = (e) => {
                    e.stopPropagation();
                    zerarContadorShiny();
                };
            }

            const btnLimpar = banner.querySelector("#btn-limpar-shiny");
            if (btnLimpar) {
                btnLimpar.onclick = (e) => {
                    e.stopPropagation();
                    dispensarAlertaShiny();
                };
            }
            banner.onclick = () => {
                dispensarAlertaShiny();
            };
        } else {
            banner.style.background = "linear-gradient(135deg, rgba(238,153,172,0.08) 0%, rgba(202,48,53,0.04) 100%)";
            banner.style.boxShadow = "none";
            banner.style.cursor = "default";
            banner.onclick = null;
            banner.title = `Detector de Shiny via WebSocket. ${soundTitle}`;
            banner.innerHTML = `
                <div style="display: flex; align-items: center; gap: 3px; min-width: 0; overflow: hidden;">
                    <span style="font-size: 11px; opacity: 0.8;">✨</span>
                    <span style="color: #f48fb1; font-size: 9.5px; font-weight: bold; white-space: nowrap;">Shiny</span>
                    ${countBadge}
                </div>
                <div style="display: flex; align-items: center; gap: 3px; flex-shrink: 0;">
                    <button id="btn-testar-som-shiny" type="button" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #94a3b8; font-size: 8.5px; padding: 0 3px; border-radius: 3px; cursor: pointer; line-height: 1.2; opacity: ${soundOpacity};" title="${soundTitle}">${soundIcon}</button>
                    ${contadorShinies > 0 ? `<button id="btn-reset-shiny-counter" type="button" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #94a3b8; font-size: 8.5px; padding: 0 3px; border-radius: 3px; cursor: pointer; line-height: 1.2;" title="Zerar contador">🔄</button>` : ""}
                    <span style="color: #818cf8; font-size: 8.5px; font-weight: bold; background: rgba(0,0,0,0.25); padding: 1px 4px; border-radius: 3px;">Ativo</span>
                </div>
            `;

            const btnTestar = banner.querySelector("#btn-testar-som-shiny");
            if (btnTestar) {
                btnTestar.onclick = (e) => {
                    e.stopPropagation();
                    toggleSomShiny();
                };
            }

            const btnReset = banner.querySelector("#btn-reset-shiny-counter");
            if (btnReset) {
                btnReset.onclick = (e) => {
                    e.stopPropagation();
                    zerarContadorShiny();
                };
            }
        }
    }

    try {
        const fixedSalvo = localStorage.getItem("pokemon-fixed");
        if (fixedSalvo) {
            pokemonFixado = JSON.parse(fixedSalvo);
        }
        const trackingSalvo = localStorage.getItem("pokemon-reader-tracking");
        if (trackingSalvo !== null) {
            mouseTrackingEnabled = trackingSalvo === "true";
        }
        const histSalvo = localStorage.getItem("pokemon-reader-history");
        if (histSalvo) {
            historicoPokemon = JSON.parse(histSalvo);
        }
    } catch (e) {
        console.warn("[Poké Leitor] Erro ao carregar dados salvos:", e);
    }

    // =========================================================================
    // SISTEMA COMPLETO DE ANÁLISE DE CAPTURA (WEBSOCKET, INDEXEDDB & ESTATÍSTICA)
    // =========================================================================

    const CATCH_ANALYZER_DB_NAME = "JustPokedexCatchAnalyzer";
    const CATCH_ANALYZER_DB_VERSION = 1;
    const CATCH_ANALYZER_STORAGE_KEY = "pokemonCatchAnalyzerData";
    const CATCH_ANALYZER_BALLS_KEY = "pokemonCatchAnalyzerBalls";
    const CATCH_ANALYZER_ENABLED_KEY = "pokemonCatchAnalyzerEnabled";

    let dbInstance = null;
    let dbStatusText = "Inicializando...";
    let dadosCaptura = [];
    let catalogoBolas = {};
    let isCapturaAtiva = true;

    const mobsCampoMap = new Map();
    let dadosAnalyzerGame = { ballsUsed: 0, captures: 0, shinyCaptures: 0, lastUpdate: 0, temDados: false };

    let metaAmostraConfig = 500;
    let minTentativasMelhorBola = 100;
    let grupoDetalheSelecionado = null;

    const MAPA_BALL_ID_NOME = {
        1: "Poké Ball",
        2: "Great Ball",
        3: "Super Ball",
        4: "Ultra Ball",
        5: "Safari Ball",
        6: "Master Ball"
    };

    const filtrosCaptura = {
        speciesName: "",
        ballName: "",
        ballId: "",
        resultado: "todos", // todos, sucesso, falha
        variante: "todos",  // todos, normal, shiny, desconhecido
        modo: "todos",      // todos, auto, manual
        dataInicio: "",
        dataFim: "",
        minTentativas: 1,
        maxTentativas: "",
        minTaxa: "",
        maxTaxa: "",
        qualidadeAmostra: "todas", // todas, muito_pequena, pequena, media, boa, confiavel
        agrupamento: "combinacao", // pokemon, pokebola, combinacao
        ordenacao: "tentativas_desc"
    };

    // -------------------------------------------------------------------------
    // CAMADA DE PERSISTÊNCIA: INDEXEDDB COM FALLBACK LOCALSTORAGE
    // -------------------------------------------------------------------------
    function initCatchAnalyzerDB() {
        return new Promise((resolve) => {
            try {
                if (!window.indexedDB) {
                    dbStatusText = "localStorage (Fallback - Sem IndexedDB)";
                    carregarDadosFallbackLocalStorage();
                    resolve(false);
                    return;
                }

                const request = indexedDB.open(CATCH_ANALYZER_DB_NAME, CATCH_ANALYZER_DB_VERSION);

                request.onupgradeneeded = (e) => {
                    const db = e.target.result;

                    if (!db.objectStoreNames.contains("catches")) {
                        const catchStore = db.createObjectStore("catches", { keyPath: "id" });
                        catchStore.createIndex("speciesName", "speciesName", { unique: false });
                        catchStore.createIndex("ballId", "ballId", { unique: false });
                        catchStore.createIndex("timestamp", "timestamp", { unique: false });
                        catchStore.createIndex("success", "success", { unique: false });
                    }

                    if (!db.objectStoreNames.contains("balls")) {
                        db.createObjectStore("balls", { keyPath: "ballId" });
                    }

                    if (!db.objectStoreNames.contains("settings")) {
                        db.createObjectStore("settings", { keyPath: "key" });
                    }

                    if (!db.objectStoreNames.contains("metadata")) {
                        db.createObjectStore("metadata", { keyPath: "key" });
                    }
                };

                request.onsuccess = (e) => {
                    dbInstance = e.target.result;
                    dbStatusText = "IndexedDB (Ativo)";
                    carregarTodosDadosDB().then(resolve);
                };

                request.onerror = (err) => {
                    console.warn("[CatchAnalyzer] IndexedDB erro, utilizando localStorage fallback:", err);
                    dbStatusText = "localStorage (Fallback - Erro IDB)";
                    carregarDadosFallbackLocalStorage();
                    resolve(false);
                };
            } catch (e) {
                dbStatusText = "localStorage (Fallback - Exceção)";
                carregarDadosFallbackLocalStorage();
                resolve(false);
            }
        });
    }

    function carregarDadosFallbackLocalStorage() {
        try {
            const salvo = localStorage.getItem(CATCH_ANALYZER_STORAGE_KEY);
            if (salvo) dadosCaptura = JSON.parse(salvo) || [];

            const bolas = localStorage.getItem(CATCH_ANALYZER_BALLS_KEY);
            if (bolas) catalogoBolas = JSON.parse(bolas) || {};

            const enabled = localStorage.getItem(CATCH_ANALYZER_ENABLED_KEY);
            if (enabled !== null) isCapturaAtiva = enabled === "true";
        } catch (e) {
            dadosCaptura = [];
            catalogoBolas = {};
        }
    }

    function salvarFallbackLocalStorage() {
        try {
            localStorage.setItem(CATCH_ANALYZER_STORAGE_KEY, JSON.stringify(dadosCaptura));
            localStorage.setItem(CATCH_ANALYZER_BALLS_KEY, JSON.stringify(catalogoBolas));
            localStorage.setItem(CATCH_ANALYZER_ENABLED_KEY, String(isCapturaAtiva));
        } catch (e) { }
    }

    function carregarTodosDadosDB() {
        return new Promise((resolve) => {
            if (!dbInstance) {
                carregarDadosFallbackLocalStorage();
                resolve();
                return;
            }

            try {
                const tx = dbInstance.transaction(["catches", "balls", "settings"], "readonly");
                const catchStore = tx.objectStore("catches");
                const ballStore = tx.objectStore("balls");

                const reqCatches = catchStore.getAll();
                reqCatches.onsuccess = () => {
                    dadosCaptura = reqCatches.result || [];
                };

                const reqBalls = ballStore.getAll();
                reqBalls.onsuccess = () => {
                    const res = reqBalls.result || [];
                    catalogoBolas = {};
                    res.forEach(b => {
                        if (b && b.ballId !== undefined) {
                            catalogoBolas[b.ballId] = b;
                        }
                    });
                };

                tx.oncomplete = () => {
                    const salvoEnabled = localStorage.getItem(CATCH_ANALYZER_ENABLED_KEY);
                    if (salvoEnabled !== null) {
                        isCapturaAtiva = salvoEnabled === "true";
                    }
                    resolve();
                };

                tx.onerror = () => {
                    carregarDadosFallbackLocalStorage();
                    resolve();
                };
            } catch (e) {
                carregarDadosFallbackLocalStorage();
                resolve();
            }
        });
    }

    function salvarRegistroCatchDB(registro) {
        salvarFallbackLocalStorage();

        if (!dbInstance) return;
        try {
            const tx = dbInstance.transaction(["catches"], "readwrite");
            tx.objectStore("catches").put(registro);
        } catch (e) { }
    }

    function salvarBolaCatalogoDB(bolaInfo) {
        salvarFallbackLocalStorage();

        if (!dbInstance) return;
        try {
            const tx = dbInstance.transaction(["balls"], "readwrite");
            tx.objectStore("balls").put(bolaInfo);
        } catch (e) { }
    }

    function limparDadosHistoricoDB() {
        dadosCaptura = [];
        catalogoBolas = {};
        salvarFallbackLocalStorage();

        if (!dbInstance) return Promise.resolve();
        return new Promise((resolve) => {
            try {
                const tx = dbInstance.transaction(["catches", "balls"], "readwrite");
                tx.objectStore("catches").clear();
                tx.objectStore("balls").clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) {
                resolve();
            }
        });
    }

    // -------------------------------------------------------------------------
    // RECEPTOR E MENSAGENS WEBSOCKET (FIELD, CATCH-RESULT, ANALYZER)
    // -------------------------------------------------------------------------
    function processarMensagemCatchAnalyzer(msg) {
        if (!msg) return;

        if (typeof msg === "string") {
            try {
                msg = JSON.parse(msg);
            } catch (e) {
                return;
            }
        }

        if (Array.isArray(msg)) {
            msg.forEach(item => processarMensagemCatchAnalyzer(item));
            return;
        }

        if (typeof msg !== "object") return;

        const tipo = String(msg.type || msg.action || msg.event || msg.op || msg.kind || "").toLowerCase();

        if (tipo === "field") {
            wsStats.fieldCount++;
            processarMensagemField(msg);
            return;
        }

        if (tipo === "analyzer") {
            wsStats.analyzerCount++;
            processarMensagemAnalyzerGame(msg);
            return;
        }

        const ehCatch = tipo === "catch-result" ||
            tipo === "catch_result" ||
            tipo.includes("catch") ||
            msg.success !== undefined ||
            msg.caught !== undefined ||
            msg.ballName !== undefined ||
            msg.ballId !== undefined ||
            msg.ball !== undefined ||
            msg.pokeball !== undefined;

        if (ehCatch) {
            wsStats.catchResultCount++;
            wsStats.lastCatchResultTime = Date.now();
            processarCatchResultMsg(msg);
            return;
        }

        // Inspeção em propriedades internas para pacotes empacotados (detail, data, payload)
        if (msg.detail && typeof msg.detail === "object") {
            processarMensagemCatchAnalyzer(msg.detail);
        }
        if (msg.data && typeof msg.data === "object") {
            processarMensagemCatchAnalyzer(msg.data);
        }
        if (msg.payload && typeof msg.payload === "object") {
            processarMensagemCatchAnalyzer(msg.payload);
        }
    }

    function processarMensagemField(msg) {
        const agora = Date.now();

        function extrairEMantermob(obj) {
            if (!obj || typeof obj !== "object") return;
            if (obj.row !== undefined && obj.col !== undefined) {
                const r = Number(obj.row);
                const c = Number(obj.col);
                if (Number.isFinite(r) && Number.isFinite(c)) {
                    const chave = `${r}::${c}`;
                    mobsCampoMap.set(chave, {
                        row: r,
                        col: c,
                        slot: obj.slot !== undefined ? Number(obj.slot) : null,
                        speciesId: obj.speciesId !== undefined ? Number(obj.speciesId) : (obj.species !== undefined ? Number(obj.species) : null),
                        shiny: obj.shiny === true ? true : (obj.shiny === false ? false : null),
                        hp: obj.hp !== undefined ? Number(obj.hp) : null,
                        maxHp: obj.maxHp !== undefined ? Number(obj.maxHp) : (obj.maxhp !== undefined ? Number(obj.maxhp) : null),
                        dead: Boolean(obj.dead),
                        respawning: Boolean(obj.respawning),
                        timestamp: agora
                    });
                }
            }
            if (Array.isArray(obj)) {
                obj.forEach(extrairEMantermob);
            } else if (Array.isArray(obj.mobs)) {
                obj.mobs.forEach(extrairEMantermob);
            } else if (typeof obj === "object") {
                Object.values(obj).forEach(val => {
                    if (val && typeof val === "object" && (val.row !== undefined || val.speciesId !== undefined || val.mobs !== undefined)) {
                        extrairEMantermob(val);
                    }
                });
            }
        }

        extrairEMantermob(msg);

        // Limpeza de mobs no cache com mais de 30 segundos
        for (const [chave, mob] of mobsCampoMap.entries()) {
            if (agora - mob.timestamp > 30000) {
                mobsCampoMap.delete(chave);
            }
        }
    }

    function processarMensagemAnalyzerGame(msg) {
        dadosAnalyzerGame = {
            ballsUsed: Number(msg.ballsUsed ?? msg.balls ?? 0),
            captures: Number(msg.captures ?? msg.caught ?? 0),
            shinyCaptures: Number(msg.shinyCaptures ?? msg.shiny_captures ?? 0),
            lastUpdate: Date.now(),
            temDados: true
        };
        if (abaAtual === "captura") {
            atualizarPainelValidacaoAnalyzer();
        }
    }

    function processarCatchResultMsg(msg) {
        if (!isCapturaAtiva) {
            isCapturaAtiva = true;
            salvarFallbackLocalStorage();
        }

        const agora = Date.now();
        const timestamp = Number(msg.timestamp || msg.time || msg.ts || agora);
        const speciesName = String(msg.speciesName || msg.pokemonName || msg.pokemon || msg.species || msg.name || "Desconhecido").trim();
        const ballId = Number(msg.ballId ?? msg.ball_id ?? 0);
        let ballName = String(msg.ballName || msg.ball || msg.pokeball || msg.ball_name || "").trim();

        if (!ballName && MAPA_BALL_ID_NOME[ballId]) {
            ballName = MAPA_BALL_ID_NOME[ballId];
        }
        if (!ballName) {
            ballName = "Poké Ball";
        }

        const row = Number(msg.row ?? msg.r ?? msg.y ?? 0);
        const col = Number(msg.col ?? msg.c ?? msg.x ?? 0);

        let success = false;
        if (msg.success !== undefined && msg.success !== null) {
            success = Boolean(msg.success);
        } else if (msg.caught !== undefined && msg.caught !== null) {
            success = Boolean(msg.caught);
        } else {
            success = Boolean(msg.result === "success" || msg.status === "success" || msg.status === "caught");
        }

        const auto = Boolean(msg.auto || msg.isAuto || msg.is_auto);

        // Desduplicação inteligente (< 2000ms)
        const jaExisteDuplicado = dadosCaptura.some(r => {
            const mesmaEspecie = r.speciesName.toLowerCase() === speciesName.toLowerCase();
            const mesmoBallId = r.ballId === ballId;
            const mesmaPos = r.row === row && r.col === col;
            const mesmoResultado = r.success === success;
            const mesmoModo = r.auto === auto;
            const mesmoTempo = Math.abs(agora - r.timestamp) < 2000;
            return mesmaEspecie && mesmoBallId && mesmaPos && mesmoResultado && mesmoModo && mesmoTempo;
        });

        if (jaExisteDuplicado) {
            return;
        }

        // Associação com dados do mapa field mais recente (< 30s)
        const mobField = mobsCampoMap.get(`${row}::${col}`);
        let speciesId = null;
        let shiny = null;
        let shinySource = null;
        let slot = null;
        let maxHp = null;

        if (mobField && (agora - mobField.timestamp <= 30000)) {
            speciesId = mobField.speciesId;
            shiny = mobField.shiny;
            shinySource = mobField.shiny !== null ? "field" : null;
            slot = mobField.slot;
            maxHp = mobField.maxHp;
        }

        const recordId = `${timestamp}::${speciesName}::${ballId}::${row}::${col}::${success}`;

        const novoRegistro = {
            id: recordId,
            timestamp,
            speciesName,
            ballName,
            ballId,
            success,
            auto,
            row,
            col,
            speciesId,
            shiny,
            shinySource,
            slot,
            maxHp,
            schemaVersion: 1
        };

        dadosCaptura.push(novoRegistro);
        salvarRegistroCatchDB(novoRegistro);

        // Atualiza catálogo local de Pokébolas
        if (ballId > 0 || ballName) {
            if (!catalogoBolas[ballId]) {
                catalogoBolas[ballId] = {
                    ballId,
                    ballName,
                    firstSeenAt: agora,
                    lastSeenAt: agora
                };
            } else {
                catalogoBolas[ballId].ballName = ballName;
                catalogoBolas[ballId].lastSeenAt = agora;
            }
            salvarBolaCatalogoDB(catalogoBolas[ballId]);
        }

        // Dispara evento público para escutas de terceiros
        try {
            window.dispatchEvent(
                new CustomEvent("justpokedex-catch-result", {
                    detail: novoRegistro
                })
            );
        } catch (e) { }

        if (abaAtual === "captura") {
            renderizarAbaCaptura();
        }
    }

    // -------------------------------------------------------------------------
    // CÁLCULOS ESTATÍSTICOS (WILSON SCORE 95%, SEQUÊNCIAS, MÉDIAS, MEDIANAS)
    // -------------------------------------------------------------------------
    function calcularIntervaloConfiancaWilson(k, n, confidenceLevel = 0.95) {
        if (n <= 0) return { lower: "0.00", upper: "0.00" };
        const z = 1.96; // 95% CI
        const p = k / n;
        const denominator = 1 + (z * z) / n;
        const centreAdjustedProbability = p + (z * z) / (2 * n);
        const adjustedStandardDeviation = Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));

        const lowerBound = (centreAdjustedProbability - z * adjustedStandardDeviation) / denominator;
        const upperBound = (centreAdjustedProbability + z * adjustedStandardDeviation) / denominator;

        return {
            lower: Math.max(0, lowerBound * 100).toFixed(2),
            upper: Math.min(100, upperBound * 100).toFixed(2)
        };
    }

    function obterDadosFiltrados() {
        return dadosCaptura.filter(rec => {
            if (filtrosCaptura.speciesName) {
                const termo = filtrosCaptura.speciesName.toLowerCase().trim();
                if (!rec.speciesName.toLowerCase().includes(termo)) return false;
            }
            if (filtrosCaptura.ballName) {
                const termo = filtrosCaptura.ballName.toLowerCase().trim();
                if (!rec.ballName.toLowerCase().includes(termo)) return false;
            }
            if (filtrosCaptura.ballId !== "" && filtrosCaptura.ballId !== null && filtrosCaptura.ballId !== undefined) {
                if (Number(rec.ballId) !== Number(filtrosCaptura.ballId)) return false;
            }
            if (filtrosCaptura.resultado === "sucesso" && !rec.success) return false;
            if (filtrosCaptura.resultado === "falha" && rec.success) return false;

            if (filtrosCaptura.modo === "auto" && !rec.auto) return false;
            if (filtrosCaptura.modo === "manual" && rec.auto) return false;

            if (filtrosCaptura.variante === "normal" && rec.shiny === true) return false;
            if (filtrosCaptura.variante === "shiny" && rec.shiny !== true) return false;
            if (filtrosCaptura.variante === "desconhecido" && rec.shiny !== null) return false;

            if (filtrosCaptura.dataInicio) {
                const dtInicio = new Date(filtrosCaptura.dataInicio).getTime();
                if (rec.timestamp < dtInicio) return false;
            }
            if (filtrosCaptura.dataFim) {
                const dtFim = new Date(filtrosCaptura.dataFim).getTime() + 86400000;
                if (rec.timestamp > dtFim) return false;
            }
            return true;
        });
    }

    function calcularEstatisticasAgrupadas(dados, tipoAgrupamento) {
        const gruposMap = new Map();

        // Ordena cronologicamente para sequências
        const dadosOrdenados = [...dados].sort((a, b) => a.timestamp - b.timestamp);

        dadosOrdenados.forEach(rec => {
            let chave = "";
            let rotuloPokemon = rec.speciesName;
            let rotuloBola = rec.ballName;
            let ballId = rec.ballId;

            if (tipoAgrupamento === "pokemon") {
                chave = rec.speciesName.toLowerCase();
            } else if (tipoAgrupamento === "pokebola") {
                chave = `ball_${rec.ballId}`;
            } else {
                chave = `${rec.speciesName.toLowerCase()}::${rec.ballId}`;
            }

            if (!gruposMap.has(chave)) {
                gruposMap.set(chave, {
                    chave,
                    speciesName: rotuloPokemon,
                    ballName: rotuloBola,
                    ballId: ballId,
                    tentativas: 0,
                    capturas: 0,
                    falhas: 0,
                    shinyCapturas: 0,
                    normalCapturas: 0,
                    desconhecidoShiny: 0,
                    firstDate: rec.timestamp,
                    lastDate: rec.timestamp,
                    maiorSequenciaFalhas: 0,
                    sequenciaFalhasAtual: 0,
                    intervalosEntreCapturas: [],
                    tentativasDesdeUltimaCaptura: 0,
                    registros: []
                });
            }

            const g = gruposMap.get(chave);
            g.tentativas++;
            g.registros.push(rec);

            if (rec.timestamp < g.firstDate) g.firstDate = rec.timestamp;
            if (rec.timestamp > g.lastDate) g.lastDate = rec.timestamp;

            if (rec.shiny === true) g.shinyCapturas++;
            else if (rec.shiny === false) g.normalCapturas++;
            else g.desconhecidoShiny++;

            if (rec.success) {
                g.capturas++;
                g.intervalosEntreCapturas.push(g.tentativasDesdeUltimaCaptura + 1);
                g.tentativasDesdeUltimaCaptura = 0;
                g.sequenciaFalhasAtual = 0;
            } else {
                g.falhas++;
                g.tentativasDesdeUltimaCaptura++;
                g.sequenciaFalhasAtual++;
                if (g.sequenciaFalhasAtual > g.maiorSequenciaFalhas) {
                    g.maiorSequenciaFalhas = g.sequenciaFalhasAtual;
                }
            }
        });

        const minT = Number(filtrosCaptura.minTentativas) || 1;
        const maxT = Number(filtrosCaptura.maxTentativas) || Infinity;
        const minTx = Number(filtrosCaptura.minTaxa) || 0;
        const maxTx = Number(filtrosCaptura.maxTaxa) || 100;

        let resultado = Array.from(gruposMap.values()).filter(g => {
            if (g.tentativas < minT || g.tentativas > maxT) return false;
            const taxa = (g.capturas / g.tentativas) * 100;
            if (taxa < minTx || taxa > maxTx) return false;

            if (filtrosCaptura.qualidadeAmostra !== "todas") {
                if (filtrosCaptura.qualidadeAmostra === "muito_pequena" && g.tentativas >= 30) return false;
                if (filtrosCaptura.qualidadeAmostra === "pequena" && (g.tentativas < 30 || g.tentativas >= 100)) return false;
                if (filtrosCaptura.qualidadeAmostra === "media" && (g.tentativas < 100 || g.tentativas >= 500)) return false;
                if (filtrosCaptura.qualidadeAmostra === "boa" && (g.tentativas < 500 || g.tentativas >= 1000)) return false;
                if (filtrosCaptura.qualidadeAmostra === "confiavel" && g.tentativas < 1000) return false;
            }
            return true;
        });

        // Métricas complementares
        resultado.forEach(g => {
            g.taxa = (g.capturas / g.tentativas) * 100;
            g.wilsonCI = calcularIntervaloConfiancaWilson(g.capturas, g.tentativas);

            // Média de tentativas entre capturas
            if (g.intervalosEntreCapturas.length > 0) {
                const soma = g.intervalosEntreCapturas.reduce((a, b) => a + b, 0);
                g.mediaTentativasEntreCapturas = (soma / g.intervalosEntreCapturas.length).toFixed(1);

                // Mediana
                const ordenados = [...g.intervalosEntreCapturas].sort((a, b) => a - b);
                const mid = Math.floor(ordenados.length / 2);
                g.medianaTentativasEntreCapturas = ordenados.length % 2 !== 0
                    ? ordenados[mid]
                    : ((ordenados[mid - 1] + ordenados[mid]) / 2).toFixed(1);
            } else {
                g.mediaTentativasEntreCapturas = "-";
                g.medianaTentativasEntreCapturas = "-";
            }

            // Taxa nas últimas 25, 50, 100
            const ult = (n) => {
                const slice = g.registros.slice(-n);
                if (slice.length === 0) return "-";
                const caps = slice.filter(r => r.success).length;
                return ((caps / slice.length) * 100).toFixed(1) + "%";
            };

            g.taxaUltimas25 = ult(25);
            g.taxaUltimas50 = ult(50);
            g.taxaUltimas100 = ult(100);

            // Classificação da Amostra
            if (g.tentativas < 30) {
                g.amostraClass = "muito_pequena";
                g.amostraBadge = `<span class="catch-badge error" title="Amostra muito pequena (<30 tentativas). Altamente variável.">Amostra Muito Pequena</span>`;
            } else if (g.tentativas < 100) {
                g.amostraClass = "pequena";
                g.amostraBadge = `<span class="catch-badge warning" title="Amostra pequena (30-99 tentativas). Sujeita a variações.">Amostra Pequena</span>`;
            } else if (g.tentativas < 500) {
                g.amostraClass = "media";
                g.amostraBadge = `<span class="catch-badge info" title="Amostra média (100-499 tentativas). Tendência observada.">Amostra Média</span>`;
            } else if (g.tentativas < 1000) {
                g.amostraClass = "boa";
                g.amostraBadge = `<span class="catch-badge teal" title="Amostra boa (500-999 tentativas). Estimativa sólida.">Amostra Boa</span>`;
            } else {
                g.amostraClass = "confiavel";
                g.amostraBadge = `<span class="catch-badge success" title="Amostra confiável (1000+ tentativas). Alta precisão estatística.">Amostra Confiável</span>`;
            }
        });

        // Ordenação
        resultado.sort((a, b) => {
            const ord = filtrosCaptura.ordenacao;
            if (ord === "taxa_desc") {
                // Para taxa desc, prioriza grupos com tentativas suficientes para evitar distorção (1 em 1 = 100%)
                const aValido = a.tentativas >= minTentativasMelhorBola ? 1 : 0;
                const bValido = b.tentativas >= minTentativasMelhorBola ? 1 : 0;
                if (aValido !== bValido) return bValido - aValido;
                return b.taxa - a.taxa || b.tentativas - a.tentativas;
            }
            if (ord === "taxa_asc") return a.taxa - b.taxa || b.tentativas - a.tentativas;
            if (ord === "tentativas_desc") return b.tentativas - a.tentativas;
            if (ord === "tentativas_asc") return a.tentativas - b.tentativas;
            if (ord === "capturas_desc") return b.capturas - a.capturas;
            if (ord === "falhas_desc") return b.falhas - a.falhas;
            if (ord === "maior_sequencia_desc") return b.maiorSequenciaFalhas - a.maiorSequenciaFalhas;
            if (ord === "alfabetica_poke") return a.speciesName.localeCompare(b.speciesName);
            if (ord === "alfabetica_bola") return a.ballName.localeCompare(b.ballName);
            if (ord === "mais_recente") return b.lastDate - a.lastDate;
            return b.tentativas - a.tentativas;
        });

        return resultado;
    }

    // -------------------------------------------------------------------------
    // RENDERIZAÇÃO DA INTERFACE DA ABA "ANÁLISE DE CAPTURA"
    // -------------------------------------------------------------------------
    function renderizarAbaCaptura() {
        const container = document.getElementById("catch-analyzer-content");
        if (!container) return;

        const dadosFiltrados = obterDadosFiltrados();
        const estatisticas = calcularEstatisticasAgrupadas(dadosFiltrados, filtrosCaptura.agrupamento);

        // Totais gerais
        const totalTentativas = dadosFiltrados.length;
        const totalCapturas = dadosFiltrados.filter(r => r.success).length;
        const totalFalhas = totalTentativas - totalCapturas;
        const taxaGeral = totalTentativas > 0 ? ((totalCapturas / totalTentativas) * 100).toFixed(2) : "0.00";
        const wilsonGeral = calcularIntervaloConfiancaWilson(totalCapturas, totalTentativas);

        const totalShiny = dadosFiltrados.filter(r => r.success && r.shiny === true).length;
        const totalNormal = dadosFiltrados.filter(r => r.success && r.shiny === false).length;

        // Pokémon mais tentado e mais capturado
        const pokeAttemptMap = {};
        const pokeCapMap = {};
        dadosFiltrados.forEach(r => {
            pokeAttemptMap[r.speciesName] = (pokeAttemptMap[r.speciesName] || 0) + 1;
            if (r.success) pokeCapMap[r.speciesName] = (pokeCapMap[r.speciesName] || 0) + 1;
        });

        let pokeMaisTentado = "-";
        let maxAttempt = 0;
        Object.entries(pokeAttemptMap).forEach(([nome, cnt]) => {
            if (cnt > maxAttempt) { maxAttempt = cnt; pokeMaisTentado = `${nome} (${cnt})`; }
        });

        let pokeMaisCapturado = "-";
        let maxCap = 0;
        Object.entries(pokeCapMap).forEach(([nome, cnt]) => {
            if (cnt > maxCap) { maxCap = cnt; pokeMaisCapturado = `${nome} (${cnt})`; }
        });

        // Pokébola mais utilizada e Pokébola com maior taxa observada
        const ballStats = {};
        dadosFiltrados.forEach(r => {
            if (!ballStats[r.ballId]) {
                ballStats[r.ballId] = { nome: r.ballName, id: r.ballId, tot: 0, cap: 0 };
            }
            ballStats[r.ballId].tot++;
            if (r.success) ballStats[r.ballId].cap++;
        });

        let bolaMaisUtilizada = "-";
        let maxBallUsed = 0;
        Object.values(ballStats).forEach(b => {
            if (b.tot > maxBallUsed) { maxBallUsed = b.tot; bolaMaisUtilizada = `${b.nome} (${b.tot})`; }
        });

        let bolaMaiorTaxa = "-";
        let maxRateVal = -1;
        Object.values(ballStats).forEach(b => {
            if (b.tot >= minTentativasMelhorBola) {
                const r = (b.cap / b.tot) * 100;
                if (r > maxRateVal) {
                    maxRateVal = r;
                    bolaMaiorTaxa = `${b.nome} (${r.toFixed(1)}%)`;
                }
            }
        });
        if (bolaMaiorTaxa === "-" && Object.keys(ballStats).length > 0) {
            bolaMaiorTaxa = `Mínimo de ${minTentativasMelhorBola} tent. necessário`;
        }

        // Maior sequência geral de falhas
        let maiorSeqGeral = 0;
        let seqAtual = 0;
        const dadosOrdenados = [...dadosFiltrados].sort((a, b) => a.timestamp - b.timestamp);
        dadosOrdenados.forEach(r => {
            if (!r.success) {
                seqAtual++;
                if (seqAtual > maiorSeqGeral) maiorSeqGeral = seqAtual;
            } else {
                seqAtual = 0;
            }
        });

        // Tempo desde a última captura
        let tempoUltimaCapTexto = "-";
        const ultimasCap = dadosOrdenados.filter(r => r.success);
        if (ultimasCap.length > 0) {
            const ultTs = ultimasCap[ultimasCap.length - 1].timestamp;
            const diffMs = Date.now() - ultTs;
            const min = Math.floor(diffMs / 60000);
            if (min < 1) tempoUltimaCapTexto = "Há menos de 1 min";
            else if (min < 60) tempoUltimaCapTexto = `Há ${min} min`;
            else {
                const hrs = Math.floor(min / 60);
                tempoUltimaCapTexto = `Há ${hrs}h ${min % 60}m`;
            }
        }

        container.innerHTML = `
            <div id="tab-captura-inner">
                <!-- CONTROLES PRINCIPAIS DA SESSÃO -->
                <div class="catch-controls-bar">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span class="catch-status-badge ${isCapturaAtiva ? '' : 'paused'}">
                            ${isCapturaAtiva ? '● Captura Ativa' : '⏸ Captura Pausada'}
                        </span>
                        <span style="color: #64748b; font-size: 9px;">• ${formatarNumero(wsStats.receivedMessagesCount)} msgs WS</span>
                    </div>

                    <div class="catch-btn-group">
                        <button id="btn-toggle-captura" type="button" class="catch-btn ${isCapturaAtiva ? 'danger' : 'primary'}">
                            ${isCapturaAtiva ? '⏸ Pausar' : '▶ Retomar'}
                        </button>
                        <button id="btn-recalcular-stats" type="button" class="catch-btn">🔄 Recalcular</button>
                        <button id="btn-limpar-historico" type="button" class="catch-btn danger">🗑️ Limpar</button>
                    </div>
                </div>

                <!-- CARDS DE RESUMO ESTATÍSTICO (6 PAINÉIS) -->
                <div class="catch-cards-grid">
                    <div class="catch-stat-card">
                        <span class="card-lbl">Tentativas</span>
                        <span class="card-val">${formatarNumero(totalTentativas)}</span>
                        <span class="card-sub">Tentativas salvas</span>
                    </div>
                    <div class="catch-stat-card">
                        <span class="card-lbl">Capturas</span>
                        <span class="card-val" style="color: #34d399;">${formatarNumero(totalCapturas)}</span>
                        <span class="card-sub">Sucessos totais</span>
                    </div>
                    <div class="catch-stat-card">
                        <span class="card-lbl">Falhas</span>
                        <span class="card-val" style="color: #f87171;">${formatarNumero(totalFalhas)}</span>
                        <span class="card-sub">Fugas / Erros</span>
                    </div>
                    <div class="catch-stat-card">
                        <span class="card-lbl">Taxa Geral</span>
                        <span class="card-val" style="color: #f59e0b;">${taxaGeral}%</span>
                        <span class="card-sub">Capturas / Tentativas</span>
                    </div>
                    <div class="catch-stat-card">
                        <span class="card-lbl">Capturas Shiny</span>
                        <span class="card-val" style="color: #f472b6;">✨ ${formatarNumero(totalShiny)}</span>
                        <span class="card-sub">Shinies confirmados</span>
                    </div>
                    <div class="catch-stat-card">
                        <span class="card-lbl">Bola Mais Utilizada</span>
                        <span class="card-val" style="font-size: 10px; color: #a78bfa;" title="${escapeHtml(bolaMaisUtilizada)}">${escapeHtml(bolaMaisUtilizada)}</span>
                        <span class="card-sub">Maior volume</span>
                    </div>
                </div>

                <!-- TABELA DE ESTATÍSTICAS AGRUPADAS -->
                <div class="catch-table-wrapper" style="margin-top: 10px;">
                    <table class="catch-table">
                        <thead>
                            <tr>
                                <th>${filtrosCaptura.agrupamento === 'pokebola' ? 'Pokébola' : 'Pokémon'}</th>
                                ${filtrosCaptura.agrupamento === 'combinacao' ? '<th>Pokébola</th>' : ''}
                                <th>Ball ID</th>
                                <th style="text-align: right;">Tentativas</th>
                                <th style="text-align: right;">Capturas</th>
                                <th style="text-align: right;">Falhas</th>
                                <th style="text-align: right;">Taxa Real %</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${renderizarLinhasTabelaEstatisticas(estatisticas)}
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        configurarEventosFiltrosEAcoes();
    }

    function renderizarLinhasTabelaEstatisticas(estatisticas) {
        if (estatisticas.length === 0) {
            return `<tr><td colspan="7" style="text-align: center; padding: 20px; color: #64748b;">Nenhuma tentativa de captura encontrada.</td></tr>`;
        }

        return estatisticas.map(g => {
            return `
                <tr class="catch-table-row" data-chave="${escapeHtml(g.chave)}">
                    <td><strong>${escapeHtml(g.speciesName)}</strong></td>
                    ${filtrosCaptura.agrupamento === 'combinacao' ? `<td>${escapeHtml(g.ballName)}</td>` : ''}
                    <td style="color: #94a3b8; font-size: 10px;">${g.ballId || '-'}</td>
                    <td style="text-align: right; font-weight: bold;">${formatarNumero(g.tentativas)}</td>
                    <td style="text-align: right; color: #34d399; font-weight: bold;">${formatarNumero(g.capturas)}</td>
                    <td style="text-align: right; color: #f87171;">${formatarNumero(g.falhas)}</td>
                    <td style="text-align: right; color: #f59e0b; font-weight: bold; font-size: 11px;">${g.taxa.toFixed(2)}%</td>
                </tr>
            `;
        }).join("");
    }

    // -------------------------------------------------------------------------
    // DESENHO DOS GRÁFICOS EM CANVAS NATIVO (SEM DEPENDÊNCIAS EXTERNAS)
    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // EVENTOS, BOTÕES E CONFIGURAÇÃO DA INTERFACE DA CAPTURA
    // -------------------------------------------------------------------------
    function configurarEventosFiltrosEAcoes() {
        const btnToggle = document.getElementById("btn-toggle-captura");
        if (btnToggle) {
            btnToggle.onclick = () => {
                isCapturaAtiva = !isCapturaAtiva;
                salvarFallbackLocalStorage();
                renderizarAbaCaptura();
            };
        }

        const btnRecalcular = document.getElementById("btn-recalcular-stats");
        if (btnRecalcular) btnRecalcular.onclick = renderizarAbaCaptura;

        const btnLimpar = document.getElementById("btn-limpar-historico");
        if (btnLimpar) btnLimpar.onclick = limparHistoricoCaptura;

        const btnLimparFiltros = document.getElementById("btn-limpar-filtros");
        if (btnLimparFiltros) {
            btnLimparFiltros.onclick = () => {
                filtrosCaptura.speciesName = "";
                filtrosCaptura.ballName = "";
                filtrosCaptura.ballId = "";
                filtrosCaptura.resultado = "todos";
                filtrosCaptura.variante = "todos";
                filtrosCaptura.modo = "todos";
                filtrosCaptura.minTentativas = 1;
                filtrosCaptura.maxTentativas = "";
                filtrosCaptura.minTaxa = "";
                filtrosCaptura.maxTaxa = "";
                filtrosCaptura.qualidadeAmostra = "todas";
                filtrosCaptura.agrupamento = "combinacao";
                filtrosCaptura.ordenacao = "tentativas_desc";
                renderizarAbaCaptura();
            };
        }

        // Bind dos Filtros
        const bindInput = (id, prop) => {
            const el = document.getElementById(id);
            if (el) {
                el.oninput = (e) => {
                    filtrosCaptura[prop] = e.target.value;
                    renderizarAbaCaptura();
                };
            }
        };

        const bindSelect = (id, prop) => {
            const el = document.getElementById(id);
            if (el) {
                el.onchange = (e) => {
                    filtrosCaptura[prop] = e.target.value;
                    renderizarAbaCaptura();
                };
            }
        };

        bindInput("flt-species", "speciesName");
        bindInput("flt-ball", "ballName");
        bindInput("flt-ball-id", "ballId");
        bindInput("flt-min-tentativas", "minTentativas");
        bindSelect("flt-resultado", "resultado");
        bindSelect("flt-variante", "variante");
        bindSelect("flt-modo", "modo");
        bindSelect("flt-agrupamento", "agrupamento");
        bindSelect("flt-ordenacao", "ordenacao");

        // Clique em linha da tabela para abrir modal de detalhes
        document.querySelectorAll(".catch-table-row").forEach(tr => {
            tr.onclick = () => {
                const chave = tr.dataset.chave;
                if (chave) {
                    abrirModalDetalhesGrupo(chave);
                }
            };
        });
    }

    // -------------------------------------------------------------------------
    // PAINEL DE DETALHES DE GRUPO (MODAL / OVERLAY DETALHADO)
    // -------------------------------------------------------------------------
    function abrirModalDetalhesGrupo(chave) {
        const dadosFiltrados = obterDadosFiltrados();
        const estatisticas = calcularEstatisticasAgrupadas(dadosFiltrados, filtrosCaptura.agrupamento);
        const grupo = estatisticas.find(g => g.chave === chave);

        if (!grupo) return;
        grupoDetalheSelecionado = grupo;

        let modalEl = document.getElementById("catch-detail-modal");
        if (!modalEl) {
            modalEl = document.createElement("div");
            modalEl.id = "catch-detail-modal";
            modalEl.className = "catch-modal-overlay";
            document.body.appendChild(modalEl);
        }

        const registrosLogs = grupo.registros.slice(-100).reverse();

        modalEl.innerHTML = `
            <div class="catch-modal-content">
                <div class="catch-modal-header">
                    <h3>🎯 Detalhes: ${escapeHtml(grupo.speciesName)} ${filtrosCaptura.agrupamento === 'combinacao' ? '+ ' + escapeHtml(grupo.ballName) : ''}</h3>
                    <button id="btn-close-detail-modal" type="button" class="catch-modal-close">×</button>
                </div>
                <div class="catch-modal-body">
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 12px;">
                        <div class="catch-stat-card"><span class="card-lbl">Tentativas</span><span class="card-val">${formatarNumero(grupo.tentativas)}</span></div>
                        <div class="catch-stat-card"><span class="card-lbl">Capturas</span><span class="card-val" style="color: #34d399;">${formatarNumero(grupo.capturas)}</span></div>
                        <div class="catch-stat-card"><span class="card-lbl">Falhas</span><span class="card-val" style="color: #f87171;">${formatarNumero(grupo.falhas)}</span></div>
                        <div class="catch-stat-card"><span class="card-lbl">Taxa Real %</span><span class="card-val" style="color: #f59e0b;">${grupo.taxa.toFixed(2)}%</span></div>
                    </div>

                    <div style="font-size: 10px; color: #cbd5e1; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 6px;">
                        <div>
                            <div><strong>IC 95% (Wilson):</strong> ${grupo.wilsonCI.lower}% a ${grupo.wilsonCI.upper}%</div>
                            <div><strong>Maior Seq. Falhas:</strong> ${grupo.maiorSequenciaFalhas}</div>
                            <div><strong>Seq. Falhas Atual:</strong> ${grupo.sequenciaFalhasAtual}</div>
                            <div><strong>Média Tentativas/Cap:</strong> ${grupo.mediaTentativasEntreCapturas}</div>
                            <div><strong>Mediana Tentativas/Cap:</strong> ${grupo.medianaTentativasEntreCapturas}</div>
                        </div>
                        <div>
                            <div><strong>Últimas 25:</strong> ${grupo.taxaUltimas25}</div>
                            <div><strong>Últimas 50:</strong> ${grupo.taxaUltimas50}</div>
                            <div><strong>Últimas 100:</strong> ${grupo.taxaUltimas100}</div>
                            <div><strong>Shinies / Normais:</strong> ✨${grupo.shinyCapturas} / 🔵${grupo.normalCapturas}</div>
                            <div><strong>Desconhecido Shiny:</strong> ${grupo.desconhecidoShiny}</div>
                        </div>
                    </div>

                    <h4 style="font-size: 11px; color: #38bdf8; margin-bottom: 6px;">📜 Histórico Cronológico Recente (Últimos 100 registros)</h4>
                    <div style="max-height: 220px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;">
                        <table class="catch-table" style="font-size: 9.5px;">
                            <thead>
                                <tr>
                                    <th>Horário</th>
                                    <th>Resultado</th>
                                    <th>Modo</th>
                                    <th>Posição</th>
                                    <th>Shiny</th>
                                    <th>Species ID</th>
                                    <th>Max HP</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${registrosLogs.map(r => `
                                    <tr>
                                        <td>${formatarDataHoraISO(r.timestamp)}</td>
                                        <td style="color: ${r.success ? '#34d399' : '#f87171'}; font-weight: bold;">${r.success ? 'Sucesso' : 'Falha'}</td>
                                        <td>${r.auto ? 'Auto' : 'Manual'}</td>
                                        <td>(${r.row}, ${r.col})</td>
                                        <td>${r.shiny === true ? '✨ Sim' : (r.shiny === false ? 'Não' : 'Desconhecido')}</td>
                                        <td>${r.speciesId || '-'}</td>
                                        <td>${r.maxHp || '-'}</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        modalEl.style.display = "flex";

        const btnClose = modalEl.querySelector("#btn-close-detail-modal");
        if (btnClose) {
            btnClose.onclick = () => { modalEl.style.display = "none"; };
        }
        modalEl.onclick = (e) => {
            if (e.target === modalEl) modalEl.style.display = "none";
        };
    }

    // -------------------------------------------------------------------------
    // PAINEL DE DIAGNÓSTICO DO SISTEMA
    // -------------------------------------------------------------------------
    function abrirModalDiagnostico() {
        let modalEl = document.getElementById("catch-diag-modal");
        if (!modalEl) {
            modalEl = document.createElement("div");
            modalEl.id = "catch-diag-modal";
            modalEl.className = "catch-modal-overlay";
            document.body.appendChild(modalEl);
        }

        const textoDiag = `
========================================
DIAGNÓSTICO JUSTPOKÉDEX CATCH ANALYZER
========================================
- WebSocket Interceptado: ${wsStats.intercepted ? 'SIM' : 'NÃO'}
- Sockets Observados: ${wsStats.socketCount}
- Total Mensagens Recebidas: ${wsStats.receivedMessagesCount}
- Mensagens catch-result: ${wsStats.catchResultCount}
- Mensagens field: ${wsStats.fieldCount}
- Mensagens analyzer: ${wsStats.analyzerCount}
- Última Mensagem: ${wsStats.lastMessageTime ? new Date(wsStats.lastMessageTime).toLocaleTimeString() : 'Nenhuma'}
- Último catch-result: ${wsStats.lastCatchResultTime ? new Date(wsStats.lastCatchResultTime).toLocaleTimeString() : 'Nenhum'}
- Status do Armazenamento: ${dbStatusText}
- Total Registros Salvos: ${dadosCaptura.length}
- Total Pokébolas Catalogadas: ${Object.keys(catalogoBolas).length}
- Último Erro de Parsing: ${wsStats.lastError || 'Nenhum'}
========================================
        `.trim();

        modalEl.innerHTML = `
            <div class="catch-modal-content" style="max-width: 450px;">
                <div class="catch-modal-header">
                    <h3>🛠️ Diagnóstico do Sistema</h3>
                    <button id="btn-close-diag-modal" type="button" class="catch-modal-close">×</button>
                </div>
                <div class="catch-modal-body">
                    <pre style="background: #090d16; color: #38bdf8; font-family: monospace; font-size: 10px; padding: 10px; border-radius: 6px; white-space: pre-wrap; overflow-x: auto;">${escapeHtml(textoDiag)}</pre>
                    <button id="btn-copiar-diag" type="button" class="catch-btn primary" style="width: 100%; margin-top: 8px;">📋 Copiar Diagnóstico</button>
                </div>
            </div>
        `;

        modalEl.style.display = "flex";

        const btnClose = modalEl.querySelector("#btn-close-diag-modal");
        if (btnClose) btnClose.onclick = () => { modalEl.style.display = "none"; };

        const btnCopiar = modalEl.querySelector("#btn-copiar-diag");
        if (btnCopiar) {
            btnCopiar.onclick = () => {
                navigator.clipboard.writeText(textoDiag).then(() => alert("Diagnóstico copiado para a área de transferência!"));
            };
        }
        modalEl.onclick = (e) => {
            if (e.target === modalEl) modalEl.style.display = "none";
        };
    }

    // -------------------------------------------------------------------------
    // EXPORTAÇÃO, IMPORTAÇÃO E LIMPEZA
    // -------------------------------------------------------------------------
    function exportarJSONCaptura() {
        if (!dadosCaptura || dadosCaptura.length === 0) {
            alert("Não há dados de captura salvos para exportar.");
            return;
        }

        const pacoteExportacao = {
            metadata: {
                extension: "JustPokedex",
                feature: "CatchAnalyzer",
                exportDate: new Date().toISOString(),
                totalRecords: dadosCaptura.length
            },
            schemaVersion: 1,
            settings: {
                metaAmostraConfig,
                minTentativasMelhorBola
            },
            balls: catalogoBolas,
            records: dadosCaptura
        };

        const str = JSON.stringify(pacoteExportacao, null, 2);
        const blob = new Blob([str], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `justpokedex_catch_analyzer_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportarCSVCaptura() {
        if (!dadosCaptura || dadosCaptura.length === 0) {
            alert("Não há dados de captura salvos para exportar.");
            return;
        }

        const cabecalho = ["timestamp", "date", "speciesName", "ballName", "ballId", "success", "auto", "row", "col", "speciesId", "shiny", "shinySource", "slot", "maxHp"];
        const linhas = dadosCaptura.map(r => [
            r.timestamp,
            `"${formatarDataHoraISO(r.timestamp)}"`,
            `"${r.speciesName}"`,
            `"${r.ballName}"`,
            r.ballId,
            r.success ? 1 : 0,
            r.auto ? 1 : 0,
            r.row,
            r.col,
            r.speciesId !== null ? r.speciesId : "",
            r.shiny === null ? "" : (r.shiny ? 1 : 0),
            `"${r.shinySource || ""}"`,
            r.slot !== null ? r.slot : "",
            r.maxHp !== null ? r.maxHp : ""
        ].join(","));

        const csvContent = "\uFEFF" + [cabecalho.join(","), ...linhas].join("\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `justpokedex_catch_analyzer_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function importarJSONCaptura(file) {
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const parsed = JSON.parse(e.target.result);
                const listaRegistros = Array.isArray(parsed) ? parsed : (parsed.records || []);

                if (!Array.isArray(listaRegistros)) {
                    alert("O arquivo fornecido não contém uma lista de registros válida.");
                    return;
                }

                let importados = 0;
                let ignorados = 0;
                let duplicados = 0;

                listaRegistros.forEach(rec => {
                    if (rec && rec.speciesName && (rec.ballName !== undefined || rec.ballId !== undefined)) {
                        const recId = rec.id || `${rec.timestamp || Date.now()}::${rec.speciesName}::${rec.ballId || 0}::${rec.row || 0}::${rec.col || 0}::${Boolean(rec.success)}`;

                        if (dadosCaptura.some(r => r.id === recId)) {
                            duplicados++;
                        } else {
                            const novoRec = {
                                id: recId,
                                timestamp: Number(rec.timestamp || Date.now()),
                                speciesName: String(rec.speciesName),
                                ballName: String(rec.ballName || MAPA_BALL_ID_NOME[rec.ballId] || "Poké Ball"),
                                ballId: Number(rec.ballId || 0),
                                success: Boolean(rec.success),
                                auto: Boolean(rec.auto),
                                row: Number(rec.row || 0),
                                col: Number(rec.col || 0),
                                speciesId: rec.speciesId !== undefined ? rec.speciesId : null,
                                shiny: rec.shiny !== undefined ? rec.shiny : null,
                                shinySource: rec.shinySource || null,
                                slot: rec.slot !== undefined ? rec.slot : null,
                                maxHp: rec.maxHp !== undefined ? rec.maxHp : null,
                                schemaVersion: 1
                            };

                            dadosCaptura.push(novoRec);
                            salvarRegistroCatchDB(novoRec);
                            importados++;
                        }
                    } else {
                        ignorados++;
                    }
                });

                if (parsed.balls && typeof parsed.balls === "object") {
                    Object.assign(catalogoBolas, parsed.balls);
                    salvarFallbackLocalStorage();
                }

                renderizarAbaCaptura();
                alert(`Importação concluída!\n\n- Importados: ${importados}\n- Duplicados ignorados: ${duplicados}\n- Registros inválidos: ${ignorados}`);
            } catch (err) {
                alert("Erro ao processar arquivo JSON: " + err.message);
            }
        };
        reader.readAsText(file);
    }

    function limparHistoricoCaptura() {
        if (!confirm("Tem certeza que deseja apagar TODO o histórico de captura?")) return;

        if (dadosCaptura.length > 1000) {
            if (!confirm(`ATENÇÃO: Você tem ${dadosCaptura.length} registros salvos. Esta ação é irreversível. Deseja realmente excluir permanentemente?`)) {
                return;
            }
        }

        limparDadosHistoricoDB().then(() => {
            renderizarAbaCaptura();
            alert("Histórico de capturas zerado com sucesso.");
        });
    }

    function formatarDataHoraISO(ts) {
        if (!ts) return "-";
        const d = new Date(ts);
        return d.toLocaleString("pt-BR", { hour12: false });
    }

    function atualizarPainelValidacaoAnalyzer() {
        const el = document.getElementById("catch-analyzer-validation-panel");
        if (el) {
            const totalExt = dadosCaptura.length;
            const capsExt = dadosCaptura.filter(r => r.success).length;
            const shinyExt = dadosCaptura.filter(r => r.success && r.shiny === true).length;
            el.innerHTML = renderizarHTMLPainelValidacaoAnalyzer(totalExt, capsExt, shinyExt);
        }
    }

    // -------------------------------------------------------------------------
    // FUNCIONALIDADES: LOJAS PORTÁTEIS, MERCADO GLOBAL E DEPOT
    // -------------------------------------------------------------------------

    function sendGameMessage(message) {
        if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) return false;
        gameSocket.send(JSON.stringify(message));
        return true;
    }

    function requestGameEvent(type, requestType, cachedValue, timeoutMs = 2500) {
        if (cachedValue && Array.isArray(cachedValue) && cachedValue.length > 0) return Promise.resolve(cachedValue);
        return new Promise(resolve => {
            const waiters = gameEventWaiters.get(type) || [];
            const waiter = message => resolve(type === "inventory" ? (message.items || message.inventory || []) : (message.list || message.pokes || message.pokemon || []));
            waiters.push(waiter);
            gameEventWaiters.set(type, waiters);
            if (!sendGameMessage({ type: requestType })) {
                gameEventWaiters.set(type, waiters.filter(item => item !== waiter));
                resolve([]);
                return;
            }
            setTimeout(() => {
                const pending = gameEventWaiters.get(type) || [];
                gameEventWaiters.set(type, pending.filter(item => item !== waiter));
                resolve(cachedValue || []);
            }, timeoutMs);
        });
    }

    async function readSellableInventoryFromDOM() {
        const findVisibleInventory = () => Array.from(document.querySelectorAll(".inv-window")).find(windowElement => {
            const style = getComputedStyle(windowElement);
            const rect = windowElement.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }) || null;

        let inventoryWindow = findVisibleInventory();
        const openedByScript = !inventoryWindow;
        if (!inventoryWindow) {
            document.querySelector('[data-guide="dock-inventory"]')?.click();
            for (let attempt = 0; attempt < 15 && !inventoryWindow; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                inventoryWindow = findVisibleInventory();
            }
        }
        if (!inventoryWindow) return [];

        let catalogById = new Map();
        try {
            const payload = await fetch("https://poke.idleworld.online/game/items.json").then(r => r.json());
            const itemsList = Array.isArray(payload) ? payload : (payload.items || []);
            itemsList.forEach(item => {
                if (item && item.id) catalogById.set(String(item.id), item);
            });
        } catch (e) { }

        const entries = Array.from(inventoryWindow.querySelectorAll('.inv-slot[data-guide^="inv-item-"]'))
            .map(slot => {
                const itemId = slot.dataset.guide.replace("inv-item-", "");
                const imgEl = slot.querySelector(".inv-ico");
                const iconSrc = imgEl?.src || imgEl?.dataset?.src || "";
                const name = imgEl?.alt?.trim() || slot.querySelector(".inv-name")?.textContent?.trim() || "";
                const qty = parseInt(slot.querySelector(".inv-qty")?.textContent, 10) || 1;
                const catalogItem = catalogById.get(String(itemId));
                return {
                    id: itemId,
                    itemId,
                    icon: iconSrc || catalogItem?.icon || catalogItem?.image || `/assets/items/${itemId}.png`,
                    name: name || catalogItem?.name || `Item ${itemId}`,
                    qty,
                    quantity: qty,
                    category: String(catalogItem?.category || "").toLowerCase(),
                    npcPrice: catalogItem?.npcPrice ? Number(catalogItem.npcPrice) : 10
                };
            })
            .filter(item => item.itemId && item.qty > 0)
            .filter(item => !["heal", "revive", "stone"].includes(item.category));

        if (openedByScript) inventoryWindow.querySelector(".cfg-x")?.click();
        return entries;
    }

    function showPurchaseConfirm({ name, maxQuantity = 1, unitPrice, currentBalance, currency = "GOLD" }, callback) {
        document.querySelector(".purchase-confirm-backdrop")?.remove();
        const icon = currency === "DIAMONDS" ? "💎" : "$";
        const maxQty = Math.max(1, Number(maxQuantity) || 1);
        let selectedQty = maxQty;

        const backdrop = document.createElement("div");
        backdrop.className = "purchase-confirm-backdrop";
        backdrop.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);z-index:9999999;display:flex;align-items:center;justify-content:center;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

        backdrop.innerHTML = `
            <div style="background:#0c121d;border:2px solid #f1c644;border-radius:14px;padding:0;color:#e2e8f0;width:380px;max-width:92vw;box-shadow:0 20px 60px rgba(0,0,0,0.95), 0 0 20px rgba(241,198,68,0.2);overflow:hidden;">
                <!-- Cabeçalho Pokédex -->
                <div style="background:linear-gradient(180deg,#e8403d 0%,#b91f27 55%,#8e141c 100%);border-bottom:2px solid #151515;padding:10px 16px;font-size:14px;font-weight:800;color:#ffffff;display:flex;align-items:center;gap:8px;text-shadow:0 1px 2px rgba(0,0,0,0.6);">
                    <span>♦ CONFIRMAR COMPRA</span>
                </div>
                
                <div style="padding:16px;display:flex;flex-direction:column;gap:12px;">
                    <div class="confirm-subtext" style="font-size:13px;color:#e2e8f0;font-weight:700;">
                        Você vai comprar <b class="confirm-qty-label" style="color:#fcd34d;">${selectedQty}×</b> ${name}.
                    </div>

                    ${maxQty > 1 ? `
                        <div style="display:flex;flex-direction:column;gap:6px;background:#141924;border:1px solid #212c3e;border-radius:8px;padding:10px 12px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#94a3b8;font-weight:800;">
                                <span>Quantidade</span>
                                <div>
                                    <input class="confirm-qty-input" type="number" min="1" max="${maxQty}" value="${selectedQty}" style="width:54px;background:#0b0e17;border:1px solid #28374d;border-radius:4px;padding:2px 4px;color:#fff;text-align:center;font-weight:800;font-size:12px;outline:none;">
                                    <span>/ ${maxQty}</span>
                                </div>
                            </div>
                            <input class="confirm-qty-slider" type="range" min="1" max="${maxQty}" value="${selectedQty}" style="width:100%;accent-color:#e53935;cursor:pointer;margin-top:4px;">
                            <div style="display:flex;justify-content:space-between;font-size:10px;color:#64748b;font-weight:700;">
                                <span>1</span>
                                <span>${maxQty} (Todos)</span>
                            </div>
                        </div>
                    ` : ''}

                    <div style="display:flex;align-items:center;justify-content:space-between;background:#141924;border:1px solid #212c3e;border-radius:8px;padding:10px 12px;">
                        <span style="font-size:13px;color:#94a3b8;font-weight:800;">Total:</span>
                        <b class="confirm-total-val" style="font-size:15px;color:${currency === 'DIAMONDS' ? '#38bdf8' : '#4ade80'};">${icon} ${(selectedQty * unitPrice).toLocaleString("pt-BR")}</b>
                    </div>

                    <div class="confirm-balance-box" style="font-size:11px;font-weight:800;padding:6px 10px;background:#0b0e17;border:1px solid #28374d;border-radius:6px;color:#4ade80;">
                        Saldo: ${icon} ${currentBalance.toLocaleString("pt-BR")}
                    </div>

                    <div style="display:flex;gap:10px;margin-top:4px;">
                        <button class="btn-confirm-purchase" type="button" style="flex:1;padding:9px;border:1px solid #ff7961;border-radius:8px;cursor:pointer;font-weight:800;font-size:12px;background:linear-gradient(180deg,#e53935 0%,#c62828 100%);color:#fff;box-shadow:0 2px 8px rgba(229,57,53,0.4);">✓ Comprar</button>
                        <button class="btn-cancel-purchase" type="button" style="flex:1;padding:9px;border:1px solid #212c3e;border-radius:8px;cursor:pointer;font-weight:800;font-size:12px;background:#141924;color:#94a3b8;">Cancelar</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const qtyLabel = backdrop.querySelector(".confirm-qty-label");
        const qtyInput = backdrop.querySelector(".confirm-qty-input");
        const qtySlider = backdrop.querySelector(".confirm-qty-slider");
        const totalVal = backdrop.querySelector(".confirm-total-val");
        const balanceBox = backdrop.querySelector(".confirm-balance-box");
        const confirmBtn = backdrop.querySelector(".btn-confirm-purchase");

        function updateModalState(newQty) {
            selectedQty = Math.max(1, Math.min(maxQty, Number(newQty) || 1));
            if (qtyLabel) qtyLabel.textContent = `${selectedQty}×`;
            if (qtyInput) qtyInput.value = selectedQty;
            if (qtySlider) qtySlider.value = selectedQty;

            const total = selectedQty * unitPrice;
            if (totalVal) totalVal.textContent = `${icon} ${total.toLocaleString("pt-BR")}`;

            const hasBalance = currentBalance >= total;
            if (balanceBox) {
                balanceBox.style.color = hasBalance ? "#4ade80" : "#f87171";
                balanceBox.textContent = `Saldo: ${icon} ${currentBalance.toLocaleString("pt-BR")} ${hasBalance ? '✓' : '(Saldo Insuficiente)'}`;
            }
            if (confirmBtn) {
                confirmBtn.disabled = !hasBalance;
                confirmBtn.style.opacity = hasBalance ? "1" : "0.5";
                confirmBtn.style.cursor = hasBalance ? "pointer" : "not-allowed";
            }
        }

        if (qtySlider) qtySlider.addEventListener("input", (e) => updateModalState(e.target.value));
        if (qtyInput) qtyInput.addEventListener("input", (e) => updateModalState(e.target.value));

        updateModalState(selectedQty);

        backdrop.querySelector(".btn-confirm-purchase").addEventListener("click", () => {
            backdrop.remove();
            callback(selectedQty);
        });
        backdrop.querySelector(".btn-cancel-purchase").addEventListener("click", () => {
            backdrop.remove();
            callback(false);
        });
    }

    let itemCatalogMapCache = null;
    async function getItemCatalogMap() {
        if (itemCatalogMapCache) return itemCatalogMapCache;
        itemCatalogMapCache = new Map();
        try {
            const payload = await fetch("https://poke.idleworld.online/game/items.json").then(res => res.json()).catch(() => ({ items: [] }));
            const list = Array.isArray(payload) ? payload : (payload.items || Object.values(payload));
            list.forEach(item => {
                if (!item) return;
                const id = String(item.id ?? item.itemId ?? item.key ?? "").toLowerCase().trim();
                const name = String(item.name ?? item.title ?? "").toLowerCase().trim();
                const icon = item.icon || item.image || (item.id ? `https://poke.idleworld.online/assets/items/${item.id}.png` : "");
                const itemObj = { ...item, id, name, icon };
                if (id) itemCatalogMapCache.set(id, itemObj);
                if (name) itemCatalogMapCache.set(name, itemObj);
            });
        } catch (e) {
            console.warn("[JustPokedex] Erro ao carregar items.json:", e);
        }
        return itemCatalogMapCache;
    }



    function showGlobalMarketWindow() {
        document.querySelector(".script-market-backdrop")?.remove();
        const backdrop = document.createElement("div");
        backdrop.className = "script-market-backdrop";
        backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999999;display:flex;align-items:center;justify-content:center;padding:16px;";
        backdrop.innerHTML = `
            <div class="mk-window script-market-window" style="background:#0c121d;border:2px solid #f1c644;border-radius:14px;padding:0;color:#e2e8f0;width:1040px;max-width:96vw;height:min(720px, 88vh);box-shadow:0 20px 60px rgba(0,0,0,0.95), 0 0 20px rgba(241,198,68,0.2);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;">
                <!-- Cabeçalho Oficial JustPokédex -->
                <div class="mk-head" style="background:linear-gradient(180deg,#e8403d 0%,#b91f27 55%,#8e141c 100%);border-bottom:3px solid #151515;padding:10px 16px;font-size:15px;font-weight:800;color:#ffffff;display:flex;align-items:center;gap:10px;text-shadow:0 1px 2px rgba(0,0,0,0.6);flex:none;">
                    <div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(to bottom,#f34848 0%,#f34848 43%,#151515 43%,#151515 57%,#f7f7f7 57%);border:2px solid #171717;position:relative;flex:none;">
                        <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:6px;height:6px;border:1.5px solid #171717;border-radius:50%;background:#fff;"></span>
                    </div>
                    <span>JustPokédex <span style="font-size:13px;color:#fcd34d;font-weight:700;margin-left:4px;">· Mercado Global Portátil</span></span>
                    
                    <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
                        <button class="market-refresh" type="button" style="background:#171b23;color:#63b3ed;border:1px solid #273546;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:800;cursor:pointer;">↻ Atualizar</button>
                        <button class="market-close" type="button" style="background:#e53935;color:#fff;border:1px solid #ff7961;border-radius:6px;width:26px;height:26px;font-size:14px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
                    </div>
                </div>

                <!-- Sub-Barra de Saldo & Status -->
                <div style="background:#141924;border-bottom:1px solid #212c3e;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex:none;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <div style="background:#0b0e17;border:1px solid #28374d;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:800;color:#4ade80;">
                            $ Saldo: <span class="market-gold-val">$ ...</span>
                        </div>
                        <div style="background:#0b0e17;border:1px solid #28374d;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:800;color:#38bdf8;">
                            💎 Diamonds: <span class="market-diamonds-val">...</span>
                        </div>
                    </div>
                    <div class="market-status" style="color:#94a3b8;font-size:12px;font-weight:600;">Carregando...</div>
                </div>

                <!-- Corpo Principal Dividido em Sidebar Esquerda e Painel Direito -->
                <div style="display:flex;flex:1;overflow:hidden;">
                    <!-- Sidebar de Categorias na Esquerda -->
                    <div class="market-sidebar" style="width:185px;background:#0b0f19;border-right:1px solid #1c2637;padding:12px 10px;display:flex;flex-direction:column;justify-content:space-between;gap:12px;flex:none;height:100%;box-sizing:border-box;">
                        <div style="display:flex;flex-direction:column;gap:10px;">
                            <div>
                                <div style="color:#94a3b8;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;padding-left:4px;">Categorias</div>
                                <div class="market-category-pills" style="display:flex;flex-direction:column;gap:5px;"></div>
                            </div>
                        </div>

                        <!-- Gerenciamento de Anúncios e Histórico na Parte Inferior da Sidebar -->
                        <div style="border-top:1px solid #1c2637;padding-top:10px;display:flex;flex-direction:column;gap:5px;">
                            <div style="color:#94a3b8;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;padding-left:4px;">Mercado</div>
                            <button class="market-view-btn market-view-anunciar" type="button" style="background:#141924;color:#fcd34d;border:1px solid #212c3e;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800;cursor:pointer;display:flex;align-items:center;gap:8px;text-align:left;width:100%;">
                                <span>📢</span> <span>Anunciar</span>
                            </button>
                            <button class="market-view-btn market-view-meus" type="button" style="background:#141924;color:#38bdf8;border:1px solid #212c3e;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800;cursor:pointer;display:flex;align-items:center;gap:8px;text-align:left;width:100%;">
                                <span>📑</span> <span>Meus Anúncios</span> <span class="my-listings-badge" style="margin-left:auto;background:#0b0e17;border:1px solid #28374d;border-radius:10px;padding:1px 6px;font-size:10px;color:#94a3b8;">0</span>
                            </button>
                            <button class="market-view-btn market-view-historico" type="button" style="background:#141924;color:#a78bfa;border:1px solid #212c3e;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800;cursor:pointer;display:flex;align-items:center;gap:8px;text-align:left;width:100%;">
                                <span>📜</span> <span>Histórico</span>
                            </button>
                        </div>
                    </div>

                    <!-- Painel de Conteúdo Principal na Direita -->
                    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0c121d;">
                        <!-- Barra de Busca e Ordenação Superior -->
                        <div class="market-top-controls" style="background:#0c121d;border-bottom:1px solid #1c2637;padding:10px 16px;display:flex;flex-direction:column;gap:8px;flex:none;">
                            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                                <div style="display:flex;align-items:center;gap:6px;flex:1;">
                                    <input class="market-search" type="search" placeholder="Buscar anúncio..." style="flex:1;min-width:180px;background:#141924;color:#fff;border:1px solid #212c3e;border-radius:6px;padding:6px 10px;font-size:12px;outline:none;font-weight:700;">
                                    <button class="market-fav-search-btn" type="button" title="Favoritar este termo de busca" style="background:#141924;border:1px solid #212c3e;border-radius:6px;padding:5px 8px;font-size:13px;cursor:pointer;color:#94a3b8;flex:none;">⭐</button>
                                </div>

                                <select class="market-sort" style="background:#141924;color:#f8fafc;border:1px solid #212c3e;border-radius:6px;padding:6px 10px;font-size:12px;font-weight:800;outline:none;">
                                    <option value="recent">Mais recentes</option>
                                    <option value="price-asc">Menor preço</option>
                                    <option value="price-desc">Maior preço</option>
                                    <option value="iv-desc">Maior IV</option>
                                    <option value="quality-desc">Maior qualidade</option>
                                    <option value="level-desc">Maior nível</option>
                                    <option value="power-desc">Maior poder</option>
                                </select>
                            </div>

                            <!-- Faixa de Atalhos de Busca Favoritados -->
                            <div class="market-fav-pills-bar" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:2px;"></div>

                            <!-- Filtros Avançados de Pokémon -->
                            <div class="market-pokemon-filters" style="display:none;gap:10px;align-items:center;flex-wrap:wrap;padding-top:6px;border-top:1px solid #1a2433;">
                                <label style="display:flex;align-items:center;gap:5px;color:#fcd34d;font-size:11px;font-weight:800;cursor:pointer;">
                                    <input class="market-shiny-only" type="checkbox" style="accent-color:#e53935;cursor:pointer;">
                                    Somente Shiny ✨
                                </label>
                                <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:#f1c644;font-weight:800;">
                                    <span>IV:</span>
                                    <input class="market-iv-min" type="number" min="0" max="192" placeholder="de" style="width:48px;background:#0b0e17;border:1px solid #28374d;border-radius:4px;padding:3px;color:#fff;text-align:center;font-weight:700;">
                                    <span style="color:#94a3b8;">-</span>
                                    <input class="market-iv-max" type="number" min="0" max="192" placeholder="até" style="width:48px;background:#0b0e17;border:1px solid #28374d;border-radius:4px;padding:3px;color:#fff;text-align:center;font-weight:700;">
                                </div>
                                <div style="display:flex;align-items:center;gap:4px;font-size:11px;color:#94a3b8;font-weight:700;">
                                    <span>Nv:</span>
                                    <input class="market-level-min" type="number" min="1" placeholder="de" style="width:48px;background:#0b0e17;border:1px solid #28374d;border-radius:4px;padding:3px;color:#fff;text-align:center;font-weight:700;">
                                    <span style="color:#94a3b8;">-</span>
                                    <input class="market-level-max" type="number" min="1" placeholder="até" style="width:48px;background:#0b0e17;border:1px solid #28374d;border-radius:4px;padding:3px;color:#fff;text-align:center;font-weight:700;">
                                </div>
                                <label style="display:flex;align-items:center;gap:5px;color:#94a3b8;font-size:11px;font-weight:700;margin-left:auto;cursor:pointer;">
                                    <input class="market-show-offers" type="checkbox" checked style="accent-color:#e53935;cursor:pointer;">
                                    Mostrar ofertas
                                </label>
                            </div>
                        </div>

                        <!-- Lista Grid de Anúncios Rolável -->
                        <div class="market-list" style="padding:12px 16px;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill, minmax(230px, 1fr));gap:10px;flex:1;background:#0c121d;">
                            <div style="color:#94a3b8;text-align:center;padding:24px;grid-column:1/-1;font-size:13px;">Carregando Mercado Global...</div>
                        </div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(backdrop);

        const MARKET_CATEGORIES = [
            { id: "All", label: "🌐 Todos" },
            { id: "Items", label: "🧪 Itens" },
            { id: "Stones", label: "🍃 Stones" },
            { id: "Poke Balls", label: "🔴 Poké Balls" },
            { id: "Diamonds", label: "💎 Diamonds" },
            { id: "Pokemon", label: "🐉 Pokémon" }
        ];

        let activeMode = "browse"; // "browse", "anunciar", "meus", "historico"
        let activeCategory = "Items";
        let currentListings = [];
        let renderLimit = 100;

        const list = backdrop.querySelector(".market-list");
        const status = backdrop.querySelector(".market-status");
        const search = backdrop.querySelector(".market-search");
        const sortSelect = backdrop.querySelector(".market-sort");
        const showOffers = backdrop.querySelector(".market-show-offers");
        const pokemonFilters = backdrop.querySelector(".market-pokemon-filters");
        const topControls = backdrop.querySelector(".market-top-controls");
        const shinyOnly = backdrop.querySelector(".market-shiny-only");
        const ivMin = backdrop.querySelector(".market-iv-min");
        const ivMax = backdrop.querySelector(".market-iv-max");
        const levelMin = backdrop.querySelector(".market-level-min");
        const levelMax = backdrop.querySelector(".market-level-max");
        const categoryPillsEl = backdrop.querySelector(".market-category-pills");
        const btnAnunciar = backdrop.querySelector(".market-view-anunciar");
        const btnMeus = backdrop.querySelector(".market-view-meus");
        const btnHistorico = backdrop.querySelector(".market-view-historico");
        const close = () => backdrop.remove();

        // Atualiza Saldos de Gold e Diamonds
        async function updateCharacterBalance() {
            try {
                const charData = await gameApiRequest("/api/characters/me").catch(() => null);
                if (charData?.character) {
                    const g = Number(charData.character.gold || 0);
                    const d = Number(charData.character.diamonds || 0);
                    backdrop.querySelector(".market-gold-val").textContent = `$ ${g.toLocaleString("pt-BR")}`;
                    backdrop.querySelector(".market-diamonds-val").textContent = d.toLocaleString("pt-BR");
                }
            } catch (e) { }
        }
        updateCharacterBalance();

        function updateSidebarActionStyles() {
            [btnAnunciar, btnMeus, btnHistorico].forEach(b => {
                b.style.borderColor = "#212c3e";
                b.style.background = "#141924";
            });

            if (activeMode === "anunciar") {
                btnAnunciar.style.borderColor = "#fcd34d";
                btnAnunciar.style.background = "linear-gradient(180deg,#332a15 0%,#1c180e 100%)";
            } else if (activeMode === "meus") {
                btnMeus.style.borderColor = "#38bdf8";
                btnMeus.style.background = "linear-gradient(180deg,#0f2b38 0%,#091720 100%)";
            } else if (activeMode === "historico") {
                btnHistorico.style.borderColor = "#a78bfa";
                btnHistorico.style.background = "linear-gradient(180deg,#241c38 0%,#140f20 100%)";
            }
        }

        btnAnunciar.addEventListener("click", () => {
            activeMode = "anunciar";
            updateSidebarActionStyles();
            renderCategoryPills();
            topControls.style.display = "none";
            loadAnnounceView();
        });

        btnMeus.addEventListener("click", () => {
            activeMode = "meus";
            updateSidebarActionStyles();
            renderCategoryPills();
            topControls.style.display = "none";
            loadMyListings();
        });

        btnHistorico.addEventListener("click", () => {
            activeMode = "historico";
            updateSidebarActionStyles();
            renderCategoryPills();
            topControls.style.display = "none";
            loadMarketHistory();
        });

        function renderCategoryPills() {
            if (!categoryPillsEl) return;
            categoryPillsEl.innerHTML = "";
            MARKET_CATEGORIES.forEach(cat => {
                const btn = document.createElement("button");
                btn.type = "button";
                const isSelected = activeMode === "browse" && activeCategory === cat.id;
                btn.style.cssText = isSelected ?
                    "background:linear-gradient(180deg,#e53935 0%,#c62828 100%);color:#fff;border:1px solid #ff7961;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800;cursor:pointer;box-shadow:0 2px 6px rgba(229,57,53,0.4);display:flex;align-items:center;gap:8px;text-align:left;width:100%;" :
                    "background:#141924;color:#94a3b8;border:1px solid #212c3e;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800;cursor:pointer;display:flex;align-items:center;gap:8px;text-align:left;width:100%;";
                btn.textContent = cat.label;

                btn.addEventListener("click", () => {
                    activeMode = "browse";
                    activeCategory = cat.id;
                    updateSidebarActionStyles();
                    renderCategoryPills();
                    topControls.style.display = "flex";
                    renderLimit = 100;
                    load();
                });
                categoryPillsEl.appendChild(btn);
            });
        }
        renderCategoryPills();

        function getMarketEntryIcon(entry) {
            const ref = entry.item || entry.pokemon || entry.product || {};
            const kind = String(entry.kind || entry.type || "").toLowerCase();

            if (kind === "pokemon" || entry.speciesId || entry.pokemonId || entry.pokemonName || entry.ivTotal != null || activeCategory === "Pokemon") {
                const speciesId = entry.speciesId || entry.pokeId || entry.pokemonId || ref.speciesId || ref.id;
                const shiny = Boolean(entry.shiny || ref.shiny);
                if (speciesId && typeof obterUrlsSprite === "function") {
                    const urls = obterUrlsSprite(speciesId, shiny);
                    return {
                        anim: urls?.anim || "",
                        still: urls?.still || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${speciesId}.png`,
                        isPoke: true
                    };
                }
            }

            let iconUrl = entry.iconUrl || entry.icon || entry.image || ref.iconUrl || ref.icon || ref.image || "";
            const itemId = entry.refId || entry.itemId || entry.id || ref.itemId || ref.id;

            if (!iconUrl && itemId) {
                iconUrl = `/assets/items/${itemId}.png`;
            }
            if (!iconUrl) {
                iconUrl = "/assets/markitems/pokeball.png";
            }

            return {
                anim: iconUrl,
                still: "/assets/markitems/pokeball.png",
                isPoke: false
            };
        }

        const favSearchBtn = backdrop.querySelector(".market-fav-search-btn");

        function getMarketFavorites() {
            try {
                const stored = localStorage.getItem("justpokedex_market_favorites");
                return stored ? JSON.parse(stored) : ["Strange Pheromone", "Bronze Boss Token"];
            } catch (e) {
                return ["Strange Pheromone", "Bronze Boss Token"];
            }
        }

        function saveMarketFavorites(favs) {
            try {
                localStorage.setItem("justpokedex_market_favorites", JSON.stringify(favs));
            } catch (e) { }
        }

        function toggleMarketFavorite(name) {
            if (!name || typeof name !== "string") return;
            const cleanName = name.trim();
            if (!cleanName) return;
            let favs = getMarketFavorites();
            const idx = favs.findIndex(f => f.toLowerCase() === cleanName.toLowerCase());
            if (idx >= 0) {
                favs.splice(idx, 1);
            } else {
                favs.push(cleanName);
            }
            saveMarketFavorites(favs);
        }

        function renderFavoritePills() {
            const bar = backdrop.querySelector(".market-fav-pills-bar");
            if (!bar) return;
            bar.innerHTML = "";
            const favs = getMarketFavorites();
            if (favs.length === 0) {
                bar.style.display = "none";
                return;
            }
            bar.style.display = "flex";

            const label = document.createElement("span");
            label.style.cssText = "font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;margin-right:2px;";
            label.textContent = "⭐ Favoritos:";
            bar.appendChild(label);

            favs.forEach(favName => {
                const pill = document.createElement("div");
                const isActive = search.value.trim().toLowerCase() === favName.toLowerCase();
                pill.style.cssText = `display:flex;align-items:center;gap:5px;background:${isActive ? '#332a15' : '#141924'};border:1px solid ${isActive ? '#fcd34d' : '#212c3e'};border-radius:12px;padding:2px 8px;font-size:11px;font-weight:800;color:${isActive ? '#fcd34d' : '#e2e8f0'};cursor:pointer;`;

                pill.innerHTML = `
                    <span>${favName}</span>
                    <span class="remove-fav-btn" title="Remover dos favoritos" style="color:#94a3b8;font-size:10px;margin-left:2px;cursor:pointer;">✕</span>
                `;

                pill.addEventListener("click", (e) => {
                    if (e.target.classList.contains("remove-fav-btn")) {
                        e.stopPropagation();
                        toggleMarketFavorite(favName);
                        renderFavoritePills();
                        render();
                        return;
                    }
                    if (search.value.trim().toLowerCase() === favName.toLowerCase()) {
                        search.value = "";
                    } else {
                        search.value = favName;
                    }
                    renderFavoritePills();
                    renderLimit = 100;
                    render();
                });

                bar.appendChild(pill);
            });
        }
        renderFavoritePills();

        if (favSearchBtn) {
            favSearchBtn.addEventListener("click", () => {
                const query = search.value.trim();
                if (!query) {
                    alert("Digite um nome na caixa de busca para favoritar!");
                    return;
                }
                toggleMarketFavorite(query);
                renderFavoritePills();
                render();
            });
        }

        const render = () => {
            const query = search.value.trim().toLowerCase();
            let filtered = currentListings.filter(entry => {
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || "";
                if (query && !String(name).toLowerCase().includes(query)) return false;
                if (!showOffers.checked && (entry.offerOnly || Number(entry.price) <= 0)) return false;
                if (activeCategory === "Pokemon") {
                    const iv = Number(entry.ivTotal ?? -1);
                    const level = Number(entry.level ?? -1);
                    if (shinyOnly.checked && !entry.shiny) return false;
                    if (ivMin.value !== "" && iv < Number(ivMin.value)) return false;
                    if (ivMax.value !== "" && iv > Number(ivMax.value)) return false;
                    if (levelMin.value !== "" && level < Number(levelMin.value)) return false;
                    if (levelMax.value !== "" && level > Number(levelMax.value)) return false;
                }
                return true;
            });

            const sorters = {
                "price-asc": (a, b) => Number(a.price) - Number(b.price),
                "price-desc": (a, b) => Number(b.price) - Number(a.price),
                "iv-desc": (a, b) => Number(b.ivTotal ?? -1) - Number(a.ivTotal ?? -1),
                "power-desc": (a, b) => Number(b.power ?? -1) - Number(a.power ?? -1),
                "level-desc": (a, b) => Number(b.level ?? -1) - Number(a.level ?? -1),
                "quality-desc": (a, b) => Number(b.quality ?? -1) - Number(a.quality ?? -1)
            };
            if (sorters[sortSelect.value]) filtered = [...filtered].sort(sorters[sortSelect.value]);
            const visible = filtered.slice(0, renderLimit);
            list.innerHTML = "";

            status.textContent = filtered.length
                ? `Exibindo ${visible.length.toLocaleString("pt-BR")} de ${filtered.length.toLocaleString("pt-BR")} anúncios`
                : "Nenhum anúncio encontrado.";

            if (visible.length === 0) {
                list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:24px;grid-column:1/-1;font-size:13px;">Nenhum anúncio encontrado nesta categoria.</div>`;
                return;
            }

            const favList = getMarketFavorites().map(f => f.toLowerCase());

            visible.forEach(entry => {
                const ref = entry.item || entry.pokemon || entry.product || {};
                const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || "Item";
                const price = Number(entry.price ?? entry.totalPrice ?? entry.value ?? 0);
                const quantity = Number(entry.quantity ?? entry.qty ?? entry.amount ?? entry.count ?? entry.totalQty ?? entry.stock ?? (Array.isArray(entry.ids) ? entry.ids.length : 1));
                const offerOnly = Boolean(entry.offerOnly || price <= 0);
                const currency = String(entry.currency || "GOLD").toUpperCase();
                const iconData = getMarketEntryIcon(entry);
                const isFav = favList.includes(name.toLowerCase());
                const starColor = isFav ? "#fcd34d" : "#475569";

                const row = document.createElement("div");
                row.style.cssText = "display:flex;flex-direction:column;justify-content:space-between;background:#141924;border:1px solid #212c3e;border-radius:10px;padding:10px 12px;gap:8px;position:relative;";

                let priceDisplay = "";
                if (offerOnly) {
                    priceDisplay = `<span style="color:#94a3b8;font-size:11px;font-weight:800;">Somente oferta</span>`;
                } else {
                    const isDiamond = currency === "DIAMONDS";
                    const color = isDiamond ? "#38bdf8" : "#4ade80";
                    const symbol = isDiamond ? "💎" : "$";
                    priceDisplay = `<span style="color:${color};font-weight:800;font-size:13px;">${symbol} ${price.toLocaleString("pt-BR")}</span>`;
                }

                if (iconData.isPoke || entry.kind === "pokemon" || activeCategory === "Pokemon") {
                    const level = entry.level || ref.level || 1;
                    const ivTotal = entry.ivTotal ?? ref.ivTotal ?? entry.iv ?? ref.iv ?? "-";
                    const qualNum = Number(entry.quality ?? ref.quality ?? entry.multiplier ?? 0);

                    let rarityName = "";
                    let rarityColor = "#4ade80";
                    if (qualNum > 0 && typeof obterEtiquetaQualidade === "function") {
                        const et = obterEtiquetaQualidade(qualNum);
                        rarityName = `${et.label} ×${qualNum.toFixed(2)}`;
                        rarityColor = et.color;
                    } else if (entry.rarity || ref.rarity) {
                        rarityName = String(entry.rarity || ref.rarity);
                    }

                    row.innerHTML = `
                        <div style="display:flex;align-items:center;gap:10px;">
                            <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#0b0e17;border:1px solid #1c2637;border-radius:8px;flex:none;">
                                <img src="${iconData.anim}" data-fallback="${iconData.still}" style="width:36px;height:36px;object-fit:contain;" onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.dataset.fallback='';}">
                            </div>
                            <div style="overflow:hidden;flex:1;">
                                <div style="color:#f8fafc;font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px;">
                                    <span style="overflow:hidden;text-overflow:ellipsis;">${name}</span> ${entry.shiny || ref.shiny ? '<span style="color:#fcd34d;font-size:11px;">✨</span>' : ''}
                                    <span class="card-fav-star" title="Favoritar/Desfavoritar" style="color:${starColor};cursor:pointer;font-size:12px;margin-left:auto;">⭐</span>
                                </div>
                                <div style="color:#94a3b8;font-size:11px;margin-top:2px;">
                                    Nv ${level} ${rarityName ? `· <span style="color:${rarityColor};font-weight:800;">${rarityName}</span>` : ''} · IV ${ivTotal}
                                </div>
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid #1c2637;padding-top:8px;margin-top:2px;">
                            ${priceDisplay}
                            <button class="market-buy-btn" style="background:linear-gradient(180deg,#e53935 0%,#c62828 100%);color:#fff;border:1px solid #ff7961;border-radius:6px;padding:5px 14px;font-size:11px;font-weight:800;cursor:pointer;box-shadow:0 2px 6px rgba(229,57,53,0.4);" ${offerOnly ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Comprar</button>
                        </div>`;
                } else {
                    row.innerHTML = `
                        <div style="display:flex;align-items:center;gap:10px;">
                            <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#0b0e17;border:1px solid #1c2637;border-radius:8px;flex:none;">
                                <img src="${iconData.anim}" style="width:32px;height:32px;object-fit:contain;" onerror="this.src='/assets/markitems/pokeball.png'">
                            </div>
                            <div style="overflow:hidden;flex:1;">
                                <div style="color:#f8fafc;font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px;">
                                    <span style="overflow:hidden;text-overflow:ellipsis;">${name}</span>
                                    <span class="card-fav-star" title="Favoritar/Desfavoritar" style="color:${starColor};cursor:pointer;font-size:12px;margin-left:auto;">⭐</span>
                                </div>
                                <div style="color:#94a3b8;font-size:11px;margin-top:2px;">
                                    Qtd: <b style="color:#fff;">${quantity.toLocaleString("pt-BR")}</b>
                                </div>
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid #1c2637;padding-top:8px;margin-top:2px;">
                            ${priceDisplay}
                            <button class="market-buy-btn" style="background:linear-gradient(180deg,#e53935 0%,#c62828 100%);color:#fff;border:1px solid #ff7961;border-radius:6px;padding:5px 14px;font-size:11px;font-weight:800;cursor:pointer;box-shadow:0 2px 6px rgba(229,57,53,0.4);" ${offerOnly ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>Comprar</button>
                        </div>`;
                }

                const starBtn = row.querySelector(".card-fav-star");
                if (starBtn) {
                    starBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        toggleMarketFavorite(name);
                        renderFavoritePills();
                        render();
                    });
                }

                const buyBtn = row.querySelector(".market-buy-btn");
                if (buyBtn && !offerOnly) {
                    buyBtn.addEventListener("click", async () => {
                        buyBtn.disabled = true;
                        try {
                            const characterData = await gameApiRequest("/api/characters/me").catch(() => ({ character: { gold: 0, diamonds: 0 } }));
                            const currentBalance = currency === "DIAMONDS"
                                ? Number(characterData.character?.diamonds || 0)
                                : Number(characterData.character?.gold || 0);

                            showPurchaseConfirm({
                                name,
                                maxQuantity: quantity,
                                unitPrice: price,
                                currentBalance,
                                currency
                            }, async (selectedQty) => {
                                if (!selectedQty) {
                                    buyBtn.disabled = false;
                                    return;
                                }
                                try {
                                    const marketAction = entry.kind === "pokemon"
                                        ? { action: "buy", id: entry.id, quantity: selectedQty }
                                        : {
                                            action: "buy-stack",
                                            kind: entry.kind,
                                            refId: entry.refId,
                                            price: entry.price,
                                            currency: entry.currency,
                                            quantity: selectedQty,
                                            ids: entry.ids ?? [entry.id]
                                        };
                                    sendGameMessage({ type: "market-buy", id: entry.id, refId: entry.refId, quantity: selectedQty });
                                    sendGameMessage({ type: "buy-stack", refId: entry.refId, quantity: selectedQty });

                                    await gameApiRequest("/api/game/market/action", {
                                        method: "POST",
                                        body: JSON.stringify(marketAction)
                                    }).catch(() => null);

                                    alert("Compra concluída com sucesso!");
                                    updateCharacterBalance();
                                    load();
                                } catch (err) {
                                    alert("Erro ao concluir a compra: " + err.message);
                                    buyBtn.disabled = false;
                                }
                            });
                        } catch (err) {
                            alert("Erro ao validar saldo: " + err.message);
                            buyBtn.disabled = false;
                        }
                    });
                }

                list.appendChild(row);
            });
        };

        function findGameMarketWindow() {
            return document.querySelector("div.win-window.mkt2-window, .mkt2-window, [class*='mkt2-window']") 
                || document.querySelector("nav.mkt2-tabs, nav[class*='mkt2-tabs']")?.closest("div[class*='window'], div[class*='win'], div");
        }

        async function ensureGameMarketTab(tabName) {
            console.log(`[JustPokedex Market] Solicitando aba do jogo: ${tabName}`);
            let win = findGameMarketWindow();
            if (!win) {
                console.log("[JustPokedex Market] Janela do mercado não encontrada, tentando abrir via botão CTA...");
                const cta = document.querySelector(".market-cta, [class*='market-cta'], [data-guide='dock-market'], [aria-label*='Mercado']");
                if (cta) cta.click();
                else sendGameMessage({ type: "market-open" });

                for (let i = 0; i < 25; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    win = findGameMarketWindow();
                    if (win) break;
                }
            }
            if (!win) {
                console.warn("[JustPokedex Market] Não foi possível encontrar a janela de mercado no DOM.");
                return null;
            }

            const tabsNav = win.querySelector("nav.mkt2-tabs, [class*='mkt2-tabs']") || document.querySelector("nav.mkt2-tabs, [class*='mkt2-tabs']");
            if (tabsNav) {
                const tabButtons = Array.from(tabsNav.querySelectorAll("button, .mkt2-tab, [class*='mkt2-tab']"));
                console.log("[JustPokedex Market] Abas no nav oficial do jogo:", tabButtons.map(t => t.innerText.trim()));
                const targetTab = tabButtons.find(t => t.innerText.toLowerCase().includes(tabName.toLowerCase()));
                if (targetTab) {
                    console.log(`[JustPokedex Market] Clicando na aba nativa: "${targetTab.innerText.trim()}"`);
                    targetTab.click();
                } else {
                    console.warn(`[JustPokedex Market] Aba "${tabName}" não foi encontrada no nav do jogo.`);
                }
            }
            return win;
        }

        async function waitForGameMarketBody(win, timeoutMs = 3000) {
            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                const tabsNav = document.querySelector("nav.mkt2-tabs, nav[class*='mkt2-tabs']");
                const body = document.querySelector(".mkt2-body, [class*='mkt2-body']") || tabsNav?.nextElementSibling || win?.querySelector(".mkt2-body");
                if (body) {
                    const text = body.innerText.trim();
                    if (text && !text.toLowerCase().includes("carregando") && text.length > 3) {
                        console.log("[JustPokedex Market] Corpo do mercado carregado no DOM.");
                        return body;
                    }
                }
                await new Promise(r => setTimeout(r, 100));
            }
            console.log("[JustPokedex Market] Tempo limite de carregamento atingido, lendo estado atual.");
            const tabsNav = document.querySelector("nav.mkt2-tabs, nav[class*='mkt2-tabs']");
            return document.querySelector(".mkt2-body, [class*='mkt2-body']") || tabsNav?.nextElementSibling;
        }

        function extractListingsFromMarketBody(body) {
            if (!body) return [];
            const allElements = Array.from(body.querySelectorAll("*"));
            const seenKeys = new Set();
            const items = [];

            allElements.forEach(el => {
                const text = (el.innerText || "").trim();
                if (text.includes("seu anúncio") && (text.includes("Cancelar") || text.includes("/un"))) {
                    const childMatches = Array.from(el.querySelectorAll("*")).filter(c => c.innerText && c.innerText.includes("seu anúncio") && (c.innerText.includes("Cancelar") || c.innerText.includes("/un")));
                    if (childMatches.length > 0) return;

                    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
                    if (lines.length < 2) return;

                    const name = lines[0] && !lines[0].includes("MEUS ANÚNCIOS") && !lines[0].includes("Cards") ? lines[0] : (lines[1] || "Item");
                    const qtyMatch = text.match(/([\d.]+)\s*(?:×|x)/i) || text.match(/Qtd:\s*([\d.]+)/i);
                    const quantity = qtyMatch ? Number(qtyMatch[1].replace(/\./g, "")) : 1;

                    const priceMatch = text.match(/([\d.]+)\s*\/\s*un/i) || text.match(/([\d.]+)/);
                    const price = priceMatch ? Number(priceMatch[1].replace(/\./g, "")) : 0;
                    const isDiamond = text.toLowerCase().includes("diamond") || Boolean(el.querySelector("img[src*='diamond']"));

                    const imgEl = el.querySelector("img") || el.parentElement?.querySelector("img");
                    const iconUrl = imgEl ? imgEl.src : "";
                    const origCancelBtn = Array.from(el.querySelectorAll("button, a, div")).find(b => b.innerText && b.innerText.trim() === "Cancelar")
                        || (el.innerText.includes("Cancelar") ? el : null);

                    const uniqueKey = `${name}_${price}_${quantity}`;
                    if (!seenKeys.has(uniqueKey)) {
                        seenKeys.add(uniqueKey);
                        items.push({
                            name,
                            price,
                            quantity,
                            currency: isDiamond ? "DIAMONDS" : "GOLD",
                            iconUrl,
                            origCancelBtn
                        });
                    }
                }
            });

            return items;
        }

        function extractHistoryFromMarketBody(body) {
            if (!body) return [];
            const allElements = Array.from(body.querySelectorAll("*"));
            const seenKeys = new Set();
            const items = [];

            allElements.forEach(el => {
                const text = (el.innerText || "").trim();
                if ((text.includes("Comprou") || text.includes("Vendeu")) && text.includes("/un")) {
                    const childMatches = Array.from(el.querySelectorAll("*")).filter(c => (c.innerText.includes("Comprou") || c.innerText.includes("Vendeu")) && c.innerText.includes("/un"));
                    if (childMatches.length > 0) return;

                    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
                    if (lines.length < 2) return;

                    const firstLine = lines[0];
                    const isBuy = firstLine.includes("Comprou") || firstLine.includes("Bought");
                    const qtyMatch = firstLine.match(/([\d.]+)\s*(?:×|x)/i);
                    const qty = qtyMatch ? Number(qtyMatch[1].replace(/\./g, "")) : 1;

                    let name = firstLine.replace(/^(?:🛒|💰|Vendeu|Comprou|Sold|Bought)\s*[\d.]+(?:×|x)?\s*/i, "").trim();
                    if (!name) name = "Item";

                    const priceMatch = text.match(/([\d.]+)\s*\/\s*un/i) || text.match(/([\d.]+)/);
                    const price = priceMatch ? Number(priceMatch[1].replace(/\./g, "")) : 0;
                    const isDiamond = text.toLowerCase().includes("diamond") || Boolean(el.querySelector("img[src*='diamond']"));

                    const dateMatch = text.match(/\d{2}\/\d{2}\/\d{4}[,\s]*\d{2}:\d{2}:\d{2}/) || text.match(/\d{2}:\d{2}:\d{2}/);
                    const dateStr = dateMatch ? dateMatch[0] : (lines[1] || "Recente");

                    const uniqueKey = `${name}_${price}_${qty}_${dateStr}`;
                    if (!seenKeys.has(uniqueKey)) {
                        seenKeys.add(uniqueKey);
                        items.push({
                            name,
                            price,
                            quantity: qty,
                            isBuy,
                            currency: isDiamond ? "DIAMONDS" : "GOLD",
                            dateStr
                        });
                    }
                }
            });

            return items;
        }

        const loadMyListings = async () => {
            status.textContent = "Carregando meus anúncios...";
            list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:24px;grid-column:1/-1;font-size:13px;">Carregando meus anúncios...</div>`;
            try {
                let myListings = [];

                if (Array.isArray(latestMyListingsData) && latestMyListingsData.length > 0) {
                    myListings = latestMyListingsData;
                }

                if (myListings.length === 0) {
                    let payload = await gameApiRequest("/api/game/market?category=Items").catch(() => null);
                    if (payload?.mine) {
                        myListings = payload.mine;
                        latestMyListingsData = payload.mine;
                        if (payload.history) latestHistoryData = payload.history;
                    }
                }

                if (myListings.length === 0) {
                    const win = await ensureGameMarketTab("Meus Anúncios").catch(() => null);
                    const body = await waitForGameMarketBody(win, 1500).catch(() => null);
                    if (body) {
                        myListings = extractListingsFromMarketBody(body);
                    }
                }

                const badgeEl = backdrop.querySelector(".my-listings-badge");
                if (badgeEl) badgeEl.textContent = myListings.length;

                status.textContent = `Você possui ${myListings.length} anúncio(s) ativo(s).`;

                if (myListings.length === 0) {
                    list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:32px;grid-column:1/-1;font-size:13px;">Você não possui nenhum anúncio ativo no momento.</div>`;
                    return;
                }

                list.innerHTML = "";
                myListings.forEach(entry => {
                    const ref = entry.item || entry.pokemon || entry.product || {};
                    const name = entry.name || entry.title || entry.itemName || entry.pokemonName || ref.name || ref.title || "Item";
                    const price = Number(entry.price ?? entry.totalPrice ?? entry.value ?? 0);
                    const quantity = Number(entry.quantity ?? entry.qty ?? entry.amount ?? entry.count ?? 1);
                    const currency = String(entry.currency || "GOLD").toUpperCase();
                    const iconData = getMarketEntryIcon(entry);
                    const isDiamond = currency === "DIAMONDS";
                    const symbol = isDiamond ? "💎" : "$";
                    const color = isDiamond ? "#38bdf8" : "#4ade80";
                    const iconSrc = entry.iconUrl || iconData.anim;

                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;flex-direction:column;justify-content:space-between;background:#141924;border:1px solid #212c3e;border-radius:10px;padding:10px 12px;gap:8px;position:relative;";

                    row.innerHTML = `
                        <div style="display:flex;align-items:center;gap:10px;">
                            <div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#0b0e17;border:1px solid #1c2637;border-radius:8px;flex:none;">
                                <img src="${iconSrc}" style="width:32px;height:32px;object-fit:contain;" onerror="this.src='/assets/markitems/pokeball.png'">
                            </div>
                            <div style="overflow:hidden;">
                                <div style="color:#f8fafc;font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                                    ${name}
                                </div>
                                <div style="color:#94a3b8;font-size:11px;margin-top:2px;">
                                    Qtd: <b style="color:#fff;">${quantity.toLocaleString("pt-BR")}</b>
                                </div>
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid #1c2637;padding-top:8px;margin-top:2px;">
                            <span style="color:${color};font-weight:800;font-size:13px;">${symbol} ${price.toLocaleString("pt-BR")}</span>
                            <button class="market-cancel-btn" style="background:#e53935;color:#fff;border:1px solid #ff7961;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:800;cursor:pointer;">Cancelar</button>
                        </div>`;

                    const cancelBtn = row.querySelector(".market-cancel-btn");
                    cancelBtn.addEventListener("click", async () => {
                        if (!confirm(`Deseja cancelar o anúncio de ${name}?`)) return;
                        cancelBtn.disabled = true;
                        cancelBtn.textContent = "Cancelando...";
                        try {
                            if (entry.origCancelBtn) {
                                entry.origCancelBtn.click();
                            } else {
                                const marketAction = entry.kind === "pokemon"
                                    ? { action: "cancel", id: entry.id }
                                    : { action: "cancel-stack", refId: entry.refId, id: entry.id };
                                sendGameMessage({ type: "market-cancel", id: entry.id, refId: entry.refId });
                                await gameApiRequest("/api/game/market/action", {
                                    method: "POST",
                                    body: JSON.stringify(marketAction)
                                }).catch(() => null);
                            }
                            alert("Anúncio cancelado com sucesso!");
                            loadMyListings();
                        } catch (err) {
                            alert("Erro ao cancelar anúncio: " + err.message);
                            cancelBtn.disabled = false;
                            cancelBtn.textContent = "Cancelar";
                        }
                    });

                    list.appendChild(row);
                });
            } catch (error) {
                status.textContent = "Erro ao carregar meus anúncios: " + error.message;
            }
        };

        const loadMarketHistory = async () => {
            status.textContent = "Carregando histórico...";
            list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:24px;grid-column:1/-1;font-size:13px;">Carregando histórico...</div>`;
            try {
                let historyItems = [];

                if (Array.isArray(latestHistoryData) && latestHistoryData.length > 0) {
                    historyItems = latestHistoryData;
                }

                if (historyItems.length === 0) {
                    let payload = await gameApiRequest("/api/game/market?category=Items").catch(() => null);
                    if (payload?.history) {
                        historyItems = payload.history;
                        latestHistoryData = payload.history;
                        if (payload.mine) latestMyListingsData = payload.mine;
                    }
                }

                if (historyItems.length === 0) {
                    const win = await ensureGameMarketTab("Histórico").catch(() => null);
                    const body = await waitForGameMarketBody(win, 1500).catch(() => null);
                    if (body) {
                        historyItems = extractHistoryFromMarketBody(body);
                    }
                }

                status.textContent = `Exibindo ${historyItems.length} transação(ões) recente(s).`;

                if (historyItems.length === 0) {
                    list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:32px;grid-column:1/-1;font-size:13px;">Nenhuma transação registrada no histórico.</div>`;
                    return;
                }

                list.innerHTML = "";
                historyItems.forEach(entry => {
                    const name = entry.name || entry.itemName || entry.title || "Item";
                    const price = Number(entry.price || entry.totalPrice || 0);
                    const qty = Number(entry.amount || entry.quantity || entry.qty || entry.count || 1);
                    const isBuy = Boolean(
                        entry.bought === true ||
                        entry.isBuy === true ||
                        (typeof entry.action === "string" && entry.action.toLowerCase().includes("buy")) ||
                        (typeof entry.type === "string" && entry.type.toLowerCase().includes("buy"))
                    );

                    let dateStr = "Recente";
                    const rawDate = entry.at || entry.date || entry.timestamp || entry.createdAt;
                    if (rawDate) {
                        try {
                            const d = new Date(rawDate);
                            if (!isNaN(d.getTime())) {
                                dateStr = d.toLocaleString("pt-BR", {
                                    day: "2-digit",
                                    month: "2-digit",
                                    year: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit"
                                });
                            }
                        } catch (e) { }
                    } else if (entry.dateStr) {
                        dateStr = entry.dateStr;
                    }

                    const currency = String(entry.currency || "GOLD").toUpperCase();
                    const symbol = currency === "DIAMONDS" ? "💎" : "$";

                    const row = document.createElement("div");
                    row.style.cssText = isBuy
                        ? "display:flex;align-items:center;justify-content:space-between;background:linear-gradient(90deg, #1f1315 0%, #141924 100%);border:1px solid #7f1d1d;border-radius:10px;padding:12px 16px;color:#e2e8f0;grid-column:1/-1;"
                        : "display:flex;align-items:center;justify-content:space-between;background:linear-gradient(90deg, #111f18 0%, #141924 100%);border:1px solid #14532d;border-radius:10px;padding:12px 16px;color:#e2e8f0;grid-column:1/-1;";

                    row.innerHTML = `
                        <div style="display:flex;align-items:center;gap:12px;">
                            <span style="font-size:20px;">${isBuy ? '🛒' : '💰'}</span>
                            <div>
                                <div style="font-weight:800;font-size:13px;color:#f8fafc;">
                                    <span style="color:${isBuy ? '#f87171' : '#4ade80'};font-weight:800;">${isBuy ? 'Comprou' : 'Vendeu'}</span>
                                    <span style="color:#ffffff;font-weight:800;">${qty}× ${name}</span>
                                </div>
                                <div style="font-size:11px;color:#94a3b8;margin-top:3px;font-weight:600;">
                                    📅 ${dateStr}
                                </div>
                            </div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-weight:800;font-size:14px;color:${isBuy ? '#f87171' : '#4ade80'};">
                                ${isBuy ? '-' : '+'}${symbol} ${price.toLocaleString("pt-BR")}
                                <span style="font-size:10px;color:#94a3b8;font-weight:600;">/un</span>
                            </div>
                        </div>`;
                    list.appendChild(row);
                });
            } catch (error) {
                status.textContent = "Erro ao carregar histórico: " + error.message;
            }
        };

        const loadAnnounceView = async () => {
            status.textContent = "Selecione um item do inventário para criar um anúncio.";
            list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:24px;grid-column:1/-1;font-size:13px;">Carregando seu inventário...</div>`;
            try {
                ensureGameMarketTab("Anunciar").catch(() => { });
                let invList = [];
                try {
                    invList = await requestGameEvent("inventory", "inv-get", latestInventory).catch(() => readSellableInventoryFromDOM());
                } catch (e) {
                    invList = await readSellableInventoryFromDOM();
                }

                list.innerHTML = "";

                const wrapper = document.createElement("div");
                wrapper.style.cssText = "background:#141924;border:1px solid #212c3e;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:14px;grid-column:1/-1;max-width:560px;margin:0 auto;width:100%;box-sizing:border-box;";

                let selectedItem = null;

                wrapper.innerHTML = `
                    <div style="font-weight:800;font-size:14px;color:#fcd34d;display:flex;align-items:center;gap:8px;">
                        <span>📢</span> <span>Criar Novo Anúncio no Mercado</span>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:6px;">
                        <label style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;">1. Escolha o Item para Vender:</label>
                        <div class="announce-items-grid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(64px, 1fr));gap:6px;max-height:160px;overflow-y:auto;background:#0b0e17;border:1px solid #28374d;border-radius:8px;padding:8px;">
                            ${(Array.isArray(invList) ? invList : []).map(it => {
                    const icon = getItemIconUrl(it);
                    return `
                                    <div class="announce-item-slot" data-id="${it.id || it.itemId}" data-name="${it.name}" data-qty="${it.quantity || it.qty || 1}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;background:#141924;border:1px solid #212c3e;border-radius:6px;padding:6px;cursor:pointer;position:relative;" title="${it.name}">
                                        <img src="${icon}" style="width:28px;height:28px;object-fit:contain;">
                                        <span style="font-size:9px;color:#fff;font-weight:800;margin-top:2px;">x${it.quantity || it.qty || 1}</span>
                                    </div>`;
                }).join('')}
                        </div>
                    </div>

                    <div class="announce-form-box" style="display:none;flex-direction:column;gap:10px;border-top:1px solid #212c3e;padding-top:12px;">
                        <div style="font-weight:800;font-size:13px;color:#38bdf8;" class="announce-selected-title">Item selecionado: -</div>

                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                            <div>
                                <label style="font-size:11px;font-weight:800;color:#94a3b8;display:block;margin-bottom:4px;">Preço Unitário:</label>
                                <input class="announce-price-input" type="number" min="1" value="10" style="width:100%;background:#0b0e17;border:1px solid #28374d;border-radius:6px;padding:7px;color:#fff;font-weight:800;font-size:12px;outline:none;">
                            </div>
                            <div>
                                <label style="font-size:11px;font-weight:800;color:#94a3b8;display:block;margin-bottom:4px;">Quantidade:</label>
                                <input class="announce-qty-input" type="number" min="1" value="1" style="width:100%;background:#0b0e17;border:1px solid #28374d;border-radius:6px;padding:7px;color:#fff;font-weight:800;font-size:12px;outline:none;">
                            </div>
                        </div>

                        <div style="display:flex;align-items:center;justify-content:space-between;background:#0b0e17;border:1px solid #28374d;border-radius:8px;padding:8px 12px;margin-top:4px;">
                            <span style="font-size:12px;color:#94a3b8;font-weight:700;">Moeda de Recebimento:</span>
                            <select class="announce-currency-select" style="background:#141924;color:#4ade80;border:1px solid #212c3e;border-radius:6px;padding:4px 8px;font-size:12px;font-weight:800;outline:none;">
                                <option value="GOLD">$ Gold</option>
                                <option value="DIAMONDS">💎 Diamonds</option>
                            </select>
                        </div>

                        <button class="announce-submit-btn" type="button" style="background:linear-gradient(180deg,#e53935 0%,#c62828 100%);color:#fff;border:1px solid #ff7961;border-radius:8px;padding:10px;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 2px 8px rgba(229,57,53,0.4);margin-top:6px;">
                            📢 Publicar Anúncio no Mercado
                        </button>
                    </div>`;

                list.appendChild(wrapper);

                const formBox = wrapper.querySelector(".announce-form-box");
                const selectedTitle = wrapper.querySelector(".announce-selected-title");
                const priceInput = wrapper.querySelector(".announce-price-input");
                const qtyInput = wrapper.querySelector(".announce-qty-input");
                const currencySelect = wrapper.querySelector(".announce-currency-select");
                const submitBtn = wrapper.querySelector(".announce-submit-btn");

                wrapper.querySelectorAll(".announce-item-slot").forEach(slot => {
                    slot.addEventListener("click", () => {
                        wrapper.querySelectorAll(".announce-item-slot").forEach(s => s.style.borderColor = "#212c3e");
                        slot.style.borderColor = "#fcd34d";
                        selectedItem = {
                            id: slot.dataset.id,
                            name: slot.dataset.name,
                            maxQty: parseInt(slot.dataset.qty, 10) || 1
                        };
                        selectedTitle.textContent = `Item Selecionado: ${selectedItem.name} (Máx: ${selectedItem.maxQty})`;
                        qtyInput.max = selectedItem.maxQty;
                        qtyInput.value = 1;
                        formBox.style.display = "flex";
                    });
                });

                submitBtn.addEventListener("click", async () => {
                    if (!selectedItem) return alert("Selecione um item para anunciar!");
                    const price = parseInt(priceInput.value, 10) || 0;
                    const quantity = parseInt(qtyInput.value, 10) || 1;
                    const currency = currencySelect.value;
                    if (price <= 0) return alert("Digite um preço válido maior que 0!");

                    submitBtn.disabled = true;
                    submitBtn.textContent = "Publicando...";
                    try {
                        await gameApiRequest("/api/game/market/action", {
                            method: "POST",
                            body: JSON.stringify({
                                action: "sell",
                                itemId: selectedItem.id,
                                price,
                                quantity,
                                currency
                            })
                        });
                        alert("Anúncio criado com sucesso!");
                        activeMode = "meus";
                        updateSidebarActionStyles();
                        topControls.style.display = "none";
                        loadMyListings();
                    } catch (err) {
                        alert("Erro ao publicar anúncio: " + err.message);
                        submitBtn.disabled = false;
                        submitBtn.textContent = "📢 Publicar Anúncio no Mercado";
                    }
                });

            } catch (error) {
                status.textContent = "Erro ao carregar inventário para anúncio: " + error.message;
            }
        };

        function readMarketListingsFromDOM() {
            const cards = Array.from(document.querySelectorAll(".mkt2-card, .mkt2-trow, .mkt-card, .market-listing"));
            if (!cards || cards.length === 0) return [];

            const items = [];
            cards.forEach(card => {
                const titleEl = card.querySelector(".mkt2-card-name, .mkt2-name, .mkt2-title, b, strong");
                const name = titleEl ? titleEl.innerText.trim() : card.innerText.split("\n")[0] || "Item";

                const priceEl = card.querySelector(".mkt2-card-price, .mkt2-price, .price");
                const priceText = priceEl ? priceEl.innerText : card.innerText;
                const isDiamond = priceText.toLowerCase().includes("diamond") || Boolean(card.querySelector("img[src*='diamond']"));
                const priceMatch = priceText.match(/([\d.]+)/);
                const price = priceMatch ? Number(priceMatch[1].replace(/\./g, "")) : 0;

                const qtyEl = card.querySelector(".mkt2-card-qty, .mkt2-qty, .qty, .mkt2-count");
                const qtyText = qtyEl ? qtyEl.innerText : card.innerText;
                const qtyMatch = qtyText.match(/([\d.]+)\s*(?:×|x)/i)
                    || qtyText.match(/Qtd:\s*([\d.]+)/i)
                    || qtyText.match(/(?:×|x)\s*([\d.]+)/i);
                const quantity = qtyMatch ? Number(qtyMatch[1].replace(/\./g, "")) : 1;

                const imgEl = card.querySelector("img");
                const iconUrl = imgEl ? imgEl.src : "";

                items.push({
                    name,
                    price,
                    quantity,
                    currency: isDiamond ? "DIAMONDS" : "GOLD",
                    iconUrl
                });
            });
            return items;
        }

        const load = async () => {
            status.textContent = "Carregando mercado global...";
            list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:24px;grid-column:1/-1;font-size:13px;">Carregando anúncios...</div>`;
            try {
                let payload = null;

                try {
                    payload = await gameApiRequest(`/api/game/market?category=${encodeURIComponent(activeCategory)}`);
                } catch (e) { }

                if (payload && typeof payload === "object") {
                    if (Array.isArray(payload.mine)) {
                        latestMyListingsData = payload.mine;
                        const badgeEl = backdrop.querySelector(".my-listings-badge");
                        if (badgeEl) badgeEl.textContent = payload.mine.length;
                    }
                    if (Array.isArray(payload.history)) {
                        latestHistoryData = payload.history;
                    }
                }

                let listings = Array.isArray(payload)
                    ? payload
                    : (payload?.listings || payload?.items || payload?.results || payload?.list || latestMarketData || []);

                if (!listings || listings.length === 0) {
                    const domItems = readMarketListingsFromDOM();
                    if (domItems.length > 0) listings = domItems;
                }

                currentListings = listings;
                pokemonFilters.style.display = activeCategory === "Pokemon" ? "flex" : "none";
                renderLimit = 100;
                render();
            } catch (error) {
                const domItems = readMarketListingsFromDOM();
                if (domItems.length > 0) {
                    currentListings = domItems;
                    render();
                } else {
                    status.textContent = "Nenhum anúncio retornado.";
                    list.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:24px;grid-column:1/-1;font-size:13px;">Nenhum anúncio disponível nesta categoria. Clique em <b>↻ Atualizar</b> com o mercado do jogo aberto.</div>`;
                }
            }
        };

        backdrop.querySelector(".market-close").addEventListener("click", close);
        backdrop.addEventListener("click", event => { if (event.target === backdrop) close(); });
        backdrop.querySelector(".market-refresh").addEventListener("click", () => {
            updateCharacterBalance();
            if (activeMode === "meus") loadMyListings();
            else if (activeMode === "historico") loadMarketHistory();
            else if (activeMode === "anunciar") loadAnnounceView();
            else load();
        });
        [search, sortSelect, showOffers, shinyOnly, ivMin, ivMax, levelMin, levelMax].forEach(ctrl => ctrl.addEventListener("input", () => {
            renderLimit = 100;
            render();
        }));
        load();
        // Atualiza contagem inicial de meus anúncios via WebSocket ou API
        (async () => {
            let res = await gameApiRequest("/api/game/market/my").catch(() => null);
            if (!res) {
                sendGameMessage({ type: "market-my" });
                res = await requestGameEvent("market-my", "market-my", latestMyListingsData, 1500).catch(() => null);
            }
            const arr = Array.isArray(res) ? res : (res?.listings || res?.items || latestMyListingsData || []);
            const badgeEl = backdrop.querySelector(".my-listings-badge");
            if (badgeEl) badgeEl.textContent = arr.length;
        })();
    }

    // -------------------------------------------------------------------------
    // INICIALIZAÇÃO CONTROLADA
    // -------------------------------------------------------------------------
    function inicializarTudo() {
        carregarCreatures();
        criarPainel();
        observarTooltips();
        iniciarEscutasEventos();
        observarLogDeCapturas();
        observarResgateDiario();
        atualizarBannerDetectorShiny();
        initCatchAnalyzerDB();

        setInterval(() => {
            if (typeof applyChatState === "function") applyChatState();
        }, 1500);
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        inicializarTudo();
    } else {
        window.addEventListener("DOMContentLoaded", inicializarTudo);
    }
})();