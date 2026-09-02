# Tatami — estudio de instruccionales de jiujitsu

App web (PWA) para estudiar instruccionales que ya tienes descargados en el celular.
Crea **una ficha por técnica**, cada una con **su clip** listo para verse, y tus notas al lado.

- Funciona en el navegador del teléfono y se instala en la pantalla de inicio.
- **Los videos nunca se suben a internet.** La app los abre desde tu propio almacenamiento
  y sólo guarda tiempos, notas y miniaturas.
- Funciona sin conexión.
- No cuesta nada ni necesita cuenta.

## Cómo publicarla (una sola vez)

1. En GitHub entra al repositorio → **Settings** → **Pages**.
2. En *Source* elige **Deploy from a branch**, rama `main` (o la rama donde esté este código)
   y carpeta `/ (root)`. Guarda.
3. A los dos minutos queda en:
   `https://<tu-usuario>.github.io/<repositorio>/bjj/`
4. Abre esa dirección en Chrome del teléfono → menú **⋮** → **Instalar aplicación**
   (o *Agregar a pantalla principal*).

## Cómo se usa

1. **Nuevo instruccional** → título e instructor.
2. **+ Parte** por cada archivo de video que tengas (Parte 1, Parte 2…).
3. **Pegar temario**: copia de la página del producto en bjjfanatics.com la lista de
   técnicas con sus tiempos y pégala. La app crea una ficha por técnica con su clip
   ya recortado. Entiende formatos como:
   - `3:45 Armbar desde guardia cerrada`
   - `1. Armbar desde guardia cerrada - 3:45`
   - `3:45 - 5:20 Armbar desde guardia cerrada`
4. Abre la parte y toca **Elegir video del teléfono** para vincular el archivo
   (se hace una vez por sesión; el archivo no se copia ni se sube).
5. **Subtítulos** (opcional): si el instruccional trae `.srt` o `.vtt`, la app reparte
   la transcripción dentro de la ficha de cada técnica — las notas se escriben solas.
6. Ve el clip, agrega tus detalles escribiendo o **dictando por voz**, y toca **📷 Foto**
   para guardar la miniatura del momento clave.
7. **Repaso**: la app te va sacando fichas con repetición espaciada (Otra vez / Bien / Fácil).

## Google Docs

En *Ajustes → Exportar todo* o en el botón **Exportar notas** de cada instruccional:

- **Copiar para Google Docs**: copia y pega dentro de un documento; conserva títulos y viñetas.
- **Descargar .html**: súbelo a Google Drive y ábrelo con Documentos de Google —
  se convierte con títulos, viñetas y las miniaturas incluidas.
- **Descargar .md** para cualquier app de notas (Obsidian, Notion…).
- **Respaldo .json** para restaurar todo en otro teléfono.

## Detalles técnicos

Sin dependencias ni compilación: HTML, CSS y JavaScript planos.
Los datos viven en IndexedDB del navegador; los clips son pares de tiempos
(inicio–fin) sobre el archivo local, por eso son instantáneos y no ocupan espacio.

| Archivo | Qué hace |
|---|---|
| `index.html` | estructura de la app |
| `app.css` | estilos (tema oscuro, móvil primero) |
| `app.js` | base de datos local, reproductor, fichas, repaso, exportación |
| `sw.js` | service worker: uso sin internet |
| `manifest.webmanifest` | instalación en la pantalla de inicio |

Haz un respaldo `.json` de vez en cuando: si borras los datos del navegador, las fichas se pierden.
