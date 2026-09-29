# iPhone-Anmeldung und Kontolöschung – Betrieb

Stand: 28. September 2026. Android bleibt zurückgestellt.

## Anmeldung

Die native iPhone-App nutzt `/api/portal/mobile/auth/config`, `/start` und `/exchange`. Der Server bindet Anbieter-Rückleitungen an einmalige, kurzlebige PKCE-Nachweise. Bestehende Google-Konfiguration und MFA bleiben erhalten. Native App-Rückleitung: `unfallxpartner://oauth/callback`.

Apple zusätzlich zu `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`: `OAUTH_TOKEN_ENCRYPTION_KEY` (zufälliger 32-Byte-Schlüssel, 64 Hex-Zeichen). Ohne vollständige Konfiguration bleibt Apple deaktiviert. Schlüssel außerhalb des Repositorys in der Hosting-Konfiguration verwahren und separat gesichert erhalten. Nicht ohne Migration ändern, sonst sind gespeicherte Apple-Tokens nicht mehr entschlüsselbar. Apple-Services-ID muss `https://app.unfallx.com/api/portal/oauth/apple/callback` erlauben.

## Kontolöschung

Partner können in App und Portal einen Löschauftrag anlegen und zurücknehmen. Anlegen verlangt eine höchstens 15 Minuten alte vollständige Anmeldung und die Bestätigung der eigenen E-Mail. Auch noch nicht freigeschaltete Partner können dies in der iPhone-App veranlassen.

Im internen Dashboard unter „Kontolöschungen“ regelmäßig offene Anträge bearbeiten. Angezeigte Frist: 30 Tage. Der Vorgang wird **nicht automatisch** nach 30 Tagen abgeschlossen; UNFALLX ist für die rechtzeitige Bearbeitung verantwortlich.

Vor Abschluss separat prüfen: verbleibende Kundenfälle, Originaldateien, Vertrags-/Abrechnungsbelege, Firmenkontaktdaten, Sicherungskopien und notwendige Aufbewahrung. Nicht mehr erforderliche Geschäftsdaten im jeweiligen Verwaltungsbereich entfernen. Im Löschauftrag verbleibende Kategorien, Grund und konkreten Aufbewahrungszeitraum dokumentieren; wenn nichts bleibt, ausdrücklich angeben. Der Abschluss entfernt den persönlichen Zugang samt Passwort, Anbieteridentitäten, Sitzungen, Wiederherstellungstokens, Sicherheitsdaten und Entwurfszuordnungen. Geschäftsfälle werden nicht pauschal gelöscht. Aufbewahrte Empfehlungsprovisionen werden von wiederverwendbaren Login-IDs getrennt.

Apple-Verknüpfungen werden vor Abschluss und beim Entkoppeln über Apples API widerrufen. Fehlt bei einer Altverknüpfung ein gespeichertes Token oder schlägt der Widerruf fehl, bleibt der Auftrag offen. Altverknüpfung durch erneute Apple-Anmeldung aktualisieren. Fehler nicht durch manuelles Entfernen der Identität umgehen.

Abschlussbestätigung wird in die bestehende E-Mail-Warteschlange gestellt. Unter „Versand“ unklare oder fehlgeschlagene Zustellungen prüfen. Der bereinigte Abschlussdatensatz läuft nach 90 Tagen ab; Löschkennungen (`account_erasure`) bleiben als Sperrnachweis erhalten. Deren spätere Löschung bedarf einer gesonderten Aufbewahrungsentscheidung.

## Wiederherstellung aus Backup

Vor Restore aktuelle `account_erasure`-Datensätze separat sichern. Bevor eine zurückgespielte Datenbank öffentlich erreichbar wird, diese Löschkennungen wieder einspielen und betroffene personenbezogene Datensätze erneut entfernen. Authentifizierung blockiert wiederhergestellte ältere Konten bei vorhandener Löschkennung. Eine Datenbanksicherung allein stellt die Kennungen späterer Löschungen nicht wieder her. Bestehendes Backup-Konzept um diesen Schritt ergänzen; die Software behauptet keinen automatischen Backup-Purge.

## Prüfung

184 Server-Tests bestanden, einschließlich Mandantentrennung, CSRF, frischer Anmeldung, Rücknahme, tatsächlichem Entfernen der Anmeldedaten, gesperrter Apple-Löschung bei Fehlern, Token-Verschlüsselung und Wiederregistrierung ohne alte Provisionsansprüche. Reale Apple-/Google-Anmeldung, tatsächliche E-Mail-Zustellung und vollständige Fotoaufnahme mit echtem iPhone bleiben separate Live-Abnahmen.
