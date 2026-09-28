const TEMPLATE = `Hi,{{contact.first_name}}, I\u2019m Cristian, and I help residents at {{contact.property_name}} set up their internet and electricity services. I see your move-in date is {{contact.move_in_date}} ; are you going to need both services connected on that day?`;

export function fillTemplate(parseado, lead) {
    return TEMPLATE
        .replace('{{contact.first_name}}', parseado.firstName || '')
        .replace('{{contact.property_name}}', lead.property || '')
        .replace('{{contact.move_in_date}}', parseado.moveIn || 'TBD');
}
