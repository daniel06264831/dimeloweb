const socket = io('https://dimelo-kvvj.onrender.com', { transports: ['websocket', 'polling'] });

const chatDiv = document.getElementById('chat');
const messages = document.getElementById('messages');
const form = document.getElementById('form');
const input = document.getElementById('input');
let imageInput = document.getElementById('imageInput'); // let, no const
const imgBtn = document.getElementById('imgBtn');
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const roomSelect = document.getElementById('roomSelect');
const roomList = document.getElementById('roomList');
const showCreateRoom = document.getElementById('showCreateRoom');
const createRoomDiv = document.getElementById('createRoomDiv');
const createRoomBtn = document.getElementById('createRoomBtn');
const cancelCreateRoom = document.getElementById('cancelCreateRoom');
const newRoomName = document.getElementById('newRoomName');
const newRoomType = document.getElementById('newRoomType');
const newRoomPass = document.getElementById('newRoomPass');
const joinRoomDiv = document.getElementById('joinRoomDiv');
const joinRoomName = document.getElementById('joinRoomName');
const joinRoomPass = document.getElementById('joinRoomPass');
const joinUsername = document.getElementById('joinUsername');
const joinRoomBtn = document.getElementById('joinRoomBtn');

let username = '';
let currentRoom = '';

// Emoji list (puedes agregar más)
const emojis = [
    "😀","😁","😂","🤣","😃","😄","😅","😆","😉","😊","😋","😎","😍","😘","🥰","😗","😙","😚","🙂","🤗","🤩","🤔","🤨","😐","😑","😶","🙄","😏","😣","😥","😮","🤐","😯","😪","😫","🥱","😴","😌","😛","😜","😝","🤤","😒","😓","😔","😕","🙃","🤑","😲","☹️","🙁","😖","😞","😟","😤","😢","😭","😦","😧","😨","😩","🤯","😬","😰","😱","🥵","🥶","😳","🤪","😵","😡","😠","🤬","😷","🤒","🤕","🤢","🤮","🥴","😇","🥳"
];

// Emoji picker logic
emojiBtn.onclick = (e) => {
    e.preventDefault();
    emojiPicker.innerHTML = emojis.map(e => `<button type="button" class="emoji">${e}</button>`).join('');
    const rect = emojiBtn.getBoundingClientRect();
    emojiPicker.style.display = "block";
    emojiPicker.style.left = rect.left + "px";
    emojiPicker.style.top = (rect.top - 180) + "px";
};

emojiPicker.onclick = function(ev) {
    if (ev.target.classList.contains('emoji')) {
        ev.preventDefault(); // Evita que el formulario se envíe accidentalmente
        input.value += ev.target.textContent;
        emojiPicker.style.display = "none";
        input.focus();
    }
};
document.body.addEventListener('click', function(e) {
    if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) {
        emojiPicker.style.display = "none";
    }
});

const usersDiv = document.createElement('div');
usersDiv.id = 'usersDiv';
usersDiv.className = 'users-div';
chatDiv.insertBefore(usersDiv, messages);

const leaveBtn = document.createElement('button');
leaveBtn.textContent = 'Salir de la sala';
leaveBtn.className = 'secondary leave-btn';
leaveBtn.style.marginBottom = '10px';
chatDiv.insertBefore(leaveBtn, chatDiv.firstChild);

let usersInRoom = [];

leaveBtn.onclick = () => {
    socket.emit('leave room');
    chatDiv.style.display = 'none';
    roomSelect.style.display = '';
    currentRoom = '';
    messages.innerHTML = '';
    usersDiv.innerHTML = '';
};

socket.on('users in room', function(users) {
    usersInRoom = users;
    usersDiv.innerHTML = `<span class="users-title">Usuarios en sala:</span> <span class="user-count">${users.length}</span>`;
});

function playNotification() {
    if (window.Notification && Notification.permission === "granted") {
        new Notification("Nuevo mensaje en el chat");
    } else {
        const audio = new Audio("https://cdn.pixabay.com/audio/2022/07/26/audio_124bfa4c82.mp3");
        audio.volume = 0.2;
        audio.play();
    }
}

// Solicitar permiso de notificaciones al cargar la página
if ("Notification" in window && Notification.permission !== "granted") {
    Notification.requestPermission();
}

function showBrowserNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body });
    }
}

// Solo mostrar mensajes de la sala actual
socket.on('message', function(msg) {
    if (!currentRoom) return;
    const item = document.createElement('div');
    if (msg.type === 'image') {
        item.className = (msg.user === username) ? 'me' : '';
        item.innerHTML = `<strong>${msg.user === username ? 'Yo' : msg.user}:</strong><br><img src="${msg.data}" alt="imagen" class="chat-img">`;
        if (msg.user !== username && msg.user !== 'Sistema') {
            showBrowserNotification(`${msg.user} envió una imagen`, 'Haz clic para ver en el chat');
        }
    } else if (msg.user === 'Sistema') {
        item.className = 'system';
        item.textContent = msg.text;
    } else if (msg.user === username) {
        item.className = 'me';
        item.textContent = 'Yo: ' + msg.text;
    } else {
        item.textContent = msg.user + ': ' + msg.text;
        playNotification();
        showBrowserNotification(`${msg.user} dice:`, msg.text);
    }
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
});

form.addEventListener('submit', function(e) {
    e.preventDefault();
    if (input.value && currentRoom) {
        socket.emit('chat message', input.value);
        input.value = '';
    }
});

imgBtn.onclick = () => {
    if (currentRoom) {
        // Muestra un aviso antes de abrir el input
        if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
            alert("Para enviar una foto, tu navegador puede pedir permiso para acceder a archivos o la cámara. Por favor acepta el permiso si aparece.");
        }
        imageInput = document.getElementById('imageInput');
        imageInput.click();
    }
};

function resetImageInputHandler() {
    imageInput = document.getElementById('imageInput');
    imageInput.onchange = function() {
        if (!currentRoom) return;
        // Para máxima compatibilidad, usa un FileList seguro
        const files = imageInput.files;
        if (!files || !files.length) return;
        const file = files[0];
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            socket.emit('chat image', e.target.result);
            setTimeout(() => {
                // Reemplaza el input para máxima compatibilidad móvil
                const newInput = imageInput.cloneNode();
                imageInput.parentNode.replaceChild(newInput, imageInput);
                imageInput = newInput;
                resetImageInputHandler();
            }, 300);
        };
        reader.readAsDataURL(file);
    };
}
resetImageInputHandler();

function updateRoomList() {
    socket.emit('get rooms', (rooms) => {
        roomList.innerHTML = rooms.map(r =>
            `<div>
                <b>${r.name}</b> (${r.type}${r.private ? ', privada' : ''})
                <button class="quickJoin" data-room="${r.name}" ${r.private ? '' : 'style="margin-left:8px;"'}>Entrar</button>
            </div>`
        ).join('') || '<i>No hay salas disponibles</i>';
        document.querySelectorAll('.quickJoin').forEach(btn => {
            btn.onclick = () => {
                joinRoomName.value = btn.dataset.room;
            };
        });
    });
}
updateRoomList();
setInterval(updateRoomList, 5000);

showCreateRoom.onclick = () => {
    createRoomDiv.style.display = '';
    showCreateRoom.style.display = 'none';
};
cancelCreateRoom.onclick = () => {
    createRoomDiv.style.display = 'none';
    showCreateRoom.style.display = '';
};
createRoomBtn.onclick = () => {
    const name = newRoomName.value.trim();
    const type = newRoomType.value;
    const pass = newRoomPass.value;
    if (!name) return alert('Ponle un nombre a la sala');
    socket.emit('create room', { room: name, type, password: pass }, (res) => {
        if (res.ok) {
            createRoomDiv.style.display = 'none';
            showCreateRoom.style.display = '';
            updateRoomList();
            joinRoomName.value = name;
        } else {
            alert(res.error);
        }
    });
};

// Crear y agregar el div para el enlace de la sala
const linkDiv = document.createElement('div');
linkDiv.id = 'roomLinkDiv';
linkDiv.style.display = 'none';
linkDiv.style.marginBottom = '10px';
linkDiv.style.width = '100%';
linkDiv.style.textAlign = 'center';
linkDiv.innerHTML = `
    <input id="roomLinkInput" readonly style="width:70%;padding:6px 8px;border-radius:6px;border:1px solid #e0e0e0;font-size:0.98rem;">
    <button id="copyRoomLinkBtn" class="primary" style="padding:6px 12px;margin-left:6px;font-size:0.98rem;">Copiar link</button>
`;
chatDiv.insertBefore(linkDiv, chatDiv.firstChild.nextSibling);

function showRoomLink(room) {
    const baseUrl = window.location.origin + window.location.pathname.replace(/\/$/, '');
    const url = `${baseUrl}?sala=${encodeURIComponent(room)}`;
    linkDiv.style.display = '';
    document.getElementById('roomLinkInput').value = url;
    document.getElementById('copyRoomLinkBtn').onclick = () => {
        navigator.clipboard.writeText(url).then(() => {
            document.getElementById('copyRoomLinkBtn').textContent = '¡Copiado!';
            setTimeout(() => {
                document.getElementById('copyRoomLinkBtn').textContent = 'Copiar link';
            }, 1200);
        });
    };
}

joinRoomBtn.onclick = () => {
    const room = joinRoomName.value.trim();
    const pass = joinRoomPass.value;
    const name = joinUsername.value.trim();
    if (!room || !name) return alert('Pon tu nombre y el nombre de la sala');
    socket.emit('join room', { room, username: name, password: pass }, (res) => {
        if (res.ok) {
            username = name;
            currentRoom = room;
            roomSelect.style.display = 'none';
            chatDiv.style.display = '';
            messages.innerHTML = '';
            usersDiv.innerHTML = '';
            showRoomLink(room); // Mostrar el link al entrar
            socket.emit('get users in room');
            setTimeout(() => { input.focus(); }, 300);
        } else {
            alert(res.error);
        }
    });
};

// Solicita usuarios al entrar y cuando el servidor lo indique
socket.on('update users', () => {
    socket.emit('get users in room');
});

socket.on('connect', () => {
    if (currentRoom) socket.emit('get users in room');
});

socket.emit('get users in room');

socket.on('room closed', function() {
    alert('La sala se cerró por inactividad.');
    chatDiv.style.display = 'none';
    roomSelect.style.display = '';
    currentRoom = '';
    messages.innerHTML = '';
    usersDiv.innerHTML = '';
});

// Al salir de la sala, oculta el link
leaveBtn.onclick = () => {
    socket.emit('leave room');
    chatDiv.style.display = 'none';
    roomSelect.style.display = '';
    currentRoom = '';
    messages.innerHTML = '';
    usersDiv.innerHTML = '';
    linkDiv.style.display = 'none';
};

// Al cargar la página, si hay ?sala= en la URL, autocompleta el campo de sala
window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const sala = params.get('sala');
    if (sala) {
        joinRoomName.value = sala;
        joinRoomName.focus();
    }
});
    
