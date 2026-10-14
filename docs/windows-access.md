# Use Fade on this Windows computer

Double-click **Start Fade.cmd** in the Fade checkout, or the **Fade.cmd** desktop shortcut. It opens the private candidate in `C:\Users\LENOVO\Documents\Fade Workspace`. To use another project, run:

```powershell
& 'C:\Users\LENOVO\Documents\ChatGPT\Apple-of-my-ai\Fade\Start Fade.cmd' --workspace 'C:\path\to\project'
```

The launcher reads existing OpenCode credentials into child memory and uses **OpenCode Go LongCat free for both Builder and Companion**, as explicitly requested. It probes LongCat before any user task. If LongCat is unavailable, it reports the error without substituting another model. Your usual Pi profile is preserved in a separate Windows launcher profile. No credentials are saved and no local model is started.

Start by asking the Companion to inspect a file or discussing an idea. Explicit implementation requests can start Builder work. Tab switches panes; Alt+1/2/3 selects Builder, Companion or Fade. `/help`, `/status`, `/inputs`, `/changes` and `/reports` show controls and evidence. `/pause` pauses Builder; `/quit` saves and exits. Restart recovery stays paused; inspect before `/continue`.

Windows installation, CLI and UI are implemented. This is a usable private preview, not completed production qualification. Tested free/local models have failed full Builder A→B rehearsals through endpoint failures, malformed reports or failure to run literal acceptance commands. A model claiming completion does not override missing observed checks. Do not treat an unverified slice as verified. Failed user operations are not automatically replayed on another model.

This access addition changes launcher/support files only; packaged rc.2 bytes and earlier qualification results remain unchanged.
